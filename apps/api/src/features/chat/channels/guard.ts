/**
 * Channel visibility, as a type.
 *
 * §7.3 makes the *tenant* filter structural. Authorization has two axes, and
 * private channels and DMs are the other one — leaving it to call sites is the
 * discipline model D-21 rejects, one axis over (D-34).
 *
 * `ChannelContext` is branded by a symbol this module does not export, so the
 * only way to obtain one is through the guard, and a channel-scoped repository
 * that takes one cannot be called by a caller who has not been checked. Asserting
 * one into existence is a lint error everywhere (D-54).
 *
 * **Phase 0 creates only public channels, and the rule is written whole anyway.**
 * A guard that is correct only for the case that exists today is a guard that
 * silently stops being one when the next case arrives — and the next case here is
 * the private channel, where being wrong means showing somebody a conversation
 * they were not in.
 */
import { Value } from '@sinclair/typebox/value';
import { Uuid, type ChannelType, type GuestMembershipAccess } from '@purlay/types';
import { sql, type RawBuilder, type SelectQueryBuilder } from '@purlay/db';
import type { ChatDb, ChatSchema } from '../schema';
import { isUnsentUploadOf, type ReadableAttachment } from '../../../modules/attachments/readable';
import { AppError, attachmentNotFound } from '../../../platform/errors';
import { activeWorkspaceMembership, type WorkspaceContext } from '../../../platform/tenancy';
import { guestMessageHistory, guestMessageHistoryFor } from './history-access';

/** Not exported. Naming this key is the capability, and it stays in this file. */
const visibility: unique symbol = Symbol('ChannelContext');

export interface ChannelContext {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: ChannelType;
  readonly userId: string;
  readonly guest?: GuestMembershipAccess;
  readonly [visibility]: true;
}

/**
 * **404, never 403.** Across this boundary the answer is the same whether the
 * channel is in another workspace, private and not yours, deleted, or was never
 * a channel at all — one value, so the four cannot drift apart (D-34).
 */
export const channelNotFound = (): AppError =>
  new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' });

interface VisibleChannel {
  readonly id: string;
  readonly workspaceId: string;
  readonly type: ChannelType;
  readonly guestSince: Date | string | null;
  readonly guestExpiresAt: Date | string | null;
  readonly channelJoinedAt: Date | string | null;
}

interface Scope {
  /** These channels; omitted for "every channel this user can see". */
  readonly channelIds?: readonly string[];
  /** Inside this workspace only; omitted when the channel names its own. */
  readonly workspaceId?: string;
}

/**
 * The one visibility rule, as the one query every entry point runs.
 *
 * A channel is visible to a user when it is not deleted, its workspace is not
 * deleted, the user is a member of that workspace, and it is public or the user
 * is in it. Written once so no two entry points can answer differently (D-34) —
 * and one round trip whatever the outcome, so a channel that never existed and a
 * channel in somebody else's workspace cost the same and cannot be told apart by
 * how long the refusal takes (#200).
 */
/** The channels and the joins that decide who may see them; each caller adds what it selects. */
type VisibilityQuery = SelectQueryBuilder<
  ChatSchema,
  'channels' | 'workspaces' | 'workspace_members' | 'channel_members',
  object
>;

const visibleChannels = (executor: ChatDb, userId: string | RawBuilder<string>): VisibilityQuery =>
  executor
    .selectFrom('channels')
    .innerJoin('workspaces', 'workspaces.id', 'channels.workspace_id')
    .innerJoin('workspace_members', (join) =>
      join
        .onRef('workspace_members.workspace_id', '=', 'channels.workspace_id')
        .on('workspace_members.user_id', '=', userId),
    )
    .leftJoin('channel_members', (join) =>
      join
        .onRef('channel_members.channel_id', '=', 'channels.id')
        .on('channel_members.user_id', '=', userId),
    )
    .where('channels.deleted_at', 'is', null)
    .where('workspaces.deleted_at', 'is', null)
    .where(activeWorkspaceMembership)
    .where(
      sql<boolean>`(workspace_members.access_kind = 'member'
      or workspace_members.guest_modules @> ARRAY['chat']::text[])`,
    )
    .where((eb) =>
      eb.or([
        eb.and([
          eb('channels.type', '=', 'public'),
          eb('workspace_members.access_kind', '=', 'member'),
        ]),
        eb('channel_members.user_id', 'is not', null),
      ]),
    );

/** The canonical reader's audience in one SQL statement, for notices and counter delivery. */
export const channelAudienceQuery = (
  executor: ChatDb,
  channelId: string | RawBuilder<string>,
  messageId?: string | RawBuilder<string>,
): SelectQueryBuilder<ChatSchema, 'users', { id: string }> => {
  const visible = visibleChannels(executor, sql.ref<string>('users.id'))
    .select('channels.id')
    .where('channels.id', '=', channelId)
    .$if(messageId !== undefined, (query) =>
      query.where((eb) =>
        eb.exists(
          eb
            .selectFrom('messages as audience_message')
            .select('audience_message.id')
            .whereRef('audience_message.channel_id', '=', 'channels.id')
            .where('audience_message.id', '=', messageId ?? '')
            .where('audience_message.deleted_at', 'is', null)
            .where(guestMessageHistoryFor('audience_message')),
        ),
      ),
    );
  return executor
    .selectFrom('users')
    .select('users.id')
    .where('users.deleted_at', 'is', null)
    .where('users.suspended_at', 'is', null)
    .where((eb) => eb.exists(visible));
};

const visible = async (
  executor: ChatDb,
  userId: string,
  scope: Scope,
): Promise<readonly VisibleChannel[]> => {
  let query = visibleChannels(executor, userId).select([
    'channels.id as id',
    'channels.workspace_id as workspaceId',
    'channels.type as type',
    'workspace_members.guest_since as guestSince',
    'workspace_members.guest_expires_at as guestExpiresAt',
    'channel_members.joined_at as channelJoinedAt',
  ]);
  if (scope.channelIds !== undefined) query = query.where('channels.id', 'in', scope.channelIds);
  if (scope.workspaceId !== undefined) {
    query = query.where('channels.workspace_id', '=', scope.workspaceId);
  }
  return await query.execute();
};

const mint = (userId: string, channel: VisibleChannel): ChannelContext => ({
  workspaceId: channel.workspaceId,
  channelId: channel.id,
  channelType: channel.type,
  userId,
  ...(channel.guestSince === null
    ? {}
    : {
        guest: {
          kind: 'guest' as const,
          historySince: new Date(
            Math.max(
              new Date(channel.guestSince).getTime(),
              channel.channelJoinedAt === null ? 0 : new Date(channel.channelJoinedAt).getTime(),
            ),
          ).toISOString(),
          expiresAt:
            channel.guestExpiresAt === null ? null : new Date(channel.guestExpiresAt).toISOString(),
        },
      }),
  [visibility]: true,
});

/**
 * Every channel named, or none: one invisible channel refuses the whole request,
 * with the same value as any other refusal. Answering for the visible ones would
 * tell a caller which of the others exist.
 */
const allOrNothing = async (
  executor: ChatDb,
  userId: string,
  channelIds: readonly string[],
  workspaceId?: string,
): Promise<readonly ChannelContext[]> => {
  // A non-UUID handed to PostgreSQL raises on the cast, and the boundary would
  // answer 500 where it promised 404.
  if (channelIds.length === 0 || !channelIds.every((id) => Value.Check(Uuid, id))) {
    throw channelNotFound();
  }
  const found = await visible(executor, userId, {
    channelIds,
    ...(workspaceId === undefined ? {} : { workspaceId }),
  });
  const byId = new Map(found.map((channel) => [channel.id, channel]));
  return channelIds.map((id) => {
    const channel = byId.get(id);
    if (channel === undefined) throw channelNotFound();
    return mint(userId, channel);
  });
};

/** Whether the caller is in the channel, not only able to see it (D-104). */
export const isChannelMember = async (
  executor: ChatDb,
  context: ChannelContext,
): Promise<boolean> =>
  (await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst()) !== undefined;

/**
 * The caller is in the channel, not only able to see it: seeing a public channel is not being in it,
 * so a visible non-member is refused `403 NOT_A_CHANNEL_MEMBER` with what to do (D-104, D-123 §1,
 * D-156). Every write into a channel goes through here.
 *
 * A read, not a lock. A send locks the channel's memberships in one order, after its own row is
 * written (#668), and a purge or a delete takes them all first (`lockMemberships`); a lock taken here,
 * before either, would be a second order beside theirs, and a deadlock. A leave in the same instant
 * as a write can therefore let that one write land — from somebody who was in the channel when it was
 * checked (D-156 §5).
 */
export const requireChannelMember = async (
  executor: ChatDb,
  context: ChannelContext,
  refusal: string,
): Promise<void> => {
  if (!(await isChannelMember(executor, context))) {
    throw new AppError({ code: 'NOT_A_CHANNEL_MEMBER', message: refusal });
  }
};

/**
 * For a route that names a channel and nothing else (`/api/channels/:channelId`).
 * The workspace is derived from the resource, and membership of it is part of the
 * same query rather than a second guard whose refusal has to be translated.
 */
export const requireChannelById = async (
  executor: ChatDb,
  userId: string,
  channelId: string,
): Promise<ChannelContext> => {
  const [channel] = await allOrNothing(executor, userId, [channelId]);
  if (channel === undefined) throw channelNotFound();
  return channel;
};

/** Several channels at once, all or nothing, in one query — what a subscription needs. */
export const requireChannelsById = async (
  executor: ChatDb,
  userId: string,
  channelIds: readonly string[],
): Promise<readonly ChannelContext[]> => await allOrNothing(executor, userId, channelIds);

/**
 * The channels this user can see in the workspace, each as its context: for a write across the
 * workspace that goes through a channel-scoped one per channel — marking every channel read (D-238).
 * An archived channel, whose memberships are kept (D-123), mints nothing, as it is seen by nobody.
 */
export const visibleChannelsIn = async (
  executor: ChatDb,
  context: WorkspaceContext,
): Promise<readonly ChannelContext[]> =>
  (await visible(executor, context.userId, { workspaceId: context.workspaceId })).map((channel) =>
    mint(context.userId, channel),
  );

/**
 * The channels this user can see, for a workspace-wide read.
 *
 * Search and the open-questions view narrow with `channel_id = ANY($1)` rather
 * than filtering after the fact — which is also what confines the trigram scan to
 * a few channels instead of the whole tenant (D-34).
 */
export const visibleChannelIds = async (
  executor: ChatDb,
  context: WorkspaceContext,
): Promise<readonly string[]> =>
  (await visibleChannelsIn(executor, context)).map((channel) => channel.channelId);

/** The same guarded visibility inside a workspace list's SQL snapshot, without a separate id read. */
export const visibleChannelIdsQuery = (
  executor: ChatDb,
  context: WorkspaceContext,
): SelectQueryBuilder<
  ChatSchema,
  'channels' | 'workspaces' | 'workspace_members' | 'channel_members',
  { id: string }
> =>
  visibleChannels(executor, context.userId)
    .where('channels.workspace_id', '=', context.workspaceId)
    .select('channels.id');

/** Apply the same live channel and history authority before a list's limit or cursor is computed. */
export const withinMessageHistory = (
  executor: ChatDb,
  context: WorkspaceContext | ChannelContext,
  message = 'messages',
): RawBuilder<boolean> => {
  if (context.guest === undefined) return sql<boolean>`true`;
  const permitted = visibleChannels(executor, context.userId)
    .select('channels.id')
    .where('channels.workspace_id', '=', context.workspaceId)
    .where('channels.id', '=', sql.ref<string>(`${message}.channel_id`))
    .where(guestMessageHistoryFor(message));
  return sql<boolean>`exists (${permitted})`;
};

/** The one refusal for a message that is not there for the caller; reused, never copied. */
export const messageNotFound = (): AppError =>
  new AppError({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' });

/** A message the caller may act on, and the channel it is in. */
export interface VisibleMessage {
  readonly context: ChannelContext;
  readonly messageId: string;
  /** Null for a root. Threads are two levels deep, so a reply's is always a root (I-1). */
  readonly parentId: string | null;
}

/**
 * For a route that names a message and nothing else (`/api/messages/:messageId/…`).
 *
 * The message's channel and the caller's right to see it are **one query**, built on
 * the same rule as every other entry point (`visibleChannels`), so a message that
 * does not exist, one in somebody else's workspace, one in a private channel the
 * caller is not in and one that was deleted are the same refusal and cost the same
 * round trip — two queries, one to find the channel and one to check it, would let
 * how long the refusal took say which of them it was (D-34, #200).
 *
 * A tombstoned message (D-9) is not one to act on: it has nothing to resolve, react
 * to, edit or reply under. Its thread is still read, and it can be deleted again,
 * which is what `deleted: 'include'` is for.
 */
export const requireMessageById = async (
  executor: ChatDb,
  userId: string,
  messageId: string,
  options: {
    /**
     * A deleted message is not there for anything that would act on it — a reply, a reaction, an
     * edit. Reading its thread, and deleting it again, are the two that still find its tombstone
     * (D-103 §7): a root with replies keeps its place, and a second delete is the first's answer.
     */
    readonly deleted?: 'include';
  } = {},
): Promise<VisibleMessage> => {
  if (!Value.Check(Uuid, messageId)) throw messageNotFound();
  let statement = visibleChannels(executor, userId)
    .innerJoin('messages', 'messages.channel_id', 'channels.id')
    .select([
      'channels.id as id',
      'channels.workspace_id as workspaceId',
      'channels.type as type',
      'workspace_members.guest_since as guestSince',
      'workspace_members.guest_expires_at as guestExpiresAt',
      'channel_members.joined_at as channelJoinedAt',
      'messages.parent_id as parentId',
    ])
    .where(guestMessageHistory)
    .where('messages.id', '=', messageId);
  if (options.deleted !== 'include') statement = statement.where('messages.deleted_at', 'is', null);
  const row = await statement.executeTakeFirst();
  if (row === undefined) throw messageNotFound();
  return {
    context: mint(userId, row),
    messageId,
    parentId: row.parentId,
  };
};

/**
 * For a route that names an attachment (`/api/attachments/:attachmentId`, D-109 §6): **one query**,
 * so an id that never existed, somebody else's unsent upload, one in a channel the caller cannot
 * see and one whose message was deleted are the same refusal at the same cost (as
 * `requireMessageById`, #200).
 *
 * Unattached, it is its uploader's while they are in its workspace. Attached, it is whoever can see
 * its message's channel — by `visibleChannels`, the rule every entry point uses — and nobody's once
 * the message is deleted: the tombstone hides what was shown with the words.
 */
export const requireAttachmentById = async (
  executor: ChatDb,
  userId: string,
  attachmentId: string,
): Promise<ReadableAttachment> => {
  if (!Value.Check(Uuid, attachmentId)) throw attachmentNotFound();
  const row = await executor
    .selectFrom('attachments')
    .select([
      'attachments.id as id',
      'attachments.storage_key as storageKey',
      'attachments.thumbnail_key as thumbnailKey',
      'attachments.file_name as fileName',
      'attachments.kind as kind',
    ])
    .where('attachments.id', '=', attachmentId)
    .where((eb) =>
      eb.or([
        isUnsentUploadOf(eb, userId),
        // Correlated, so it looks at this attachment's one message, not every visible one.
        eb.exists(
          visibleChannels(executor, userId)
            .innerJoin('messages', 'messages.channel_id', 'channels.id')
            .select('messages.id')
            .innerJoin('message_attachments', 'message_attachments.message_id', 'messages.id')
            .where('message_attachments.attachment_id', '=', sql.ref<string>('attachments.id'))
            .where('messages.deleted_at', 'is', null)
            .where(guestMessageHistory),
        ),
      ]),
    )
    .executeTakeFirst();
  if (row === undefined) throw attachmentNotFound();
  return row;
};
