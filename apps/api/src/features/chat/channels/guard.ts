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
import type { ChatDb, ChatSchema, ChatTx } from '../schema';
import { isUnsentUploadOf, type ReadableAttachment } from '../../../modules/attachments/readable';
import { AppError, attachmentNotFound } from '../../../platform/errors';
import {
  activeWorkspaceMembership,
  requireWorkspaceContentAccess,
  type WorkspaceContext,
} from '../../../platform/tenancy';
import {
  guestContentHistory,
  guestMessageHistory,
  guestMessageHistoryFor,
  guestThreadHistoryFor,
} from './history-access';

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
  readonly policyEpoch: string;
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

export const visibleChannels = (
  executor: ChatDb,
  userId: string | RawBuilder<string>,
  options: { readonly visibilityOnly?: boolean; readonly includeArchived?: boolean } = {},
): VisibilityQuery => {
  const visible = executor
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
    .where('workspaces.deleted_at', 'is', null)
    .where(activeWorkspaceMembership(options))
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
  return options.includeArchived === true
    ? visible
    : visible.where('channels.deleted_at', 'is', null);
};

/** Final-statement authority for timestamped channel content, including formerly unrestricted contexts. */
export const channelContentVisible = (
  executor: ChatDb,
  context: ChannelContext,
  sharedAt: RawBuilder<Date>,
): RawBuilder<boolean> =>
  sql<boolean>`exists (${visibleChannels(executor, context.userId)
    .select('channels.id')
    .where('channels.id', '=', context.channelId)
    .where('channels.workspace_id', '=', context.workspaceId)
    .where(guestContentHistory(sharedAt))
    .where((eb) =>
      eb.exists(audiencePeople(executor).select('users.id').where('users.id', '=', context.userId)),
    )})`;

/** The canonical reader's audience in one SQL statement, for notices and counter delivery. */
export const channelAudienceQuery = (
  executor: ChatDb,
  channelId: string | RawBuilder<string>,
  messageId?: string | RawBuilder<string>,
): SelectQueryBuilder<ChatSchema, 'users', { id: string }> => {
  const visible = visibleChannels(executor, sql.ref<string>('users.id'), { visibilityOnly: true })
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
  return audiencePeople(executor)
    .select('users.id')
    .where((eb) => eb.exists(visible));
};

/** The account status rule shared by notice recipients and live authority reads. */
const audiencePeople = (executor: ChatDb): SelectQueryBuilder<ChatSchema, 'users', object> =>
  executor
    .selectFrom('users')
    .where('users.deleted_at', 'is', null)
    .where('users.suspended_at', 'is', null);

/** Bounds both the statement parameters and its private result map; a broadcast is paged by recipient. */
export const LIVE_AUDIENCE_BATCH_MAX = 500;

/** Internal authority, never part of a frame or an API receipt. */
export interface LiveChannelAuthority {
  readonly userId: string;
  readonly accessKind: string;
  readonly historySince: Date | null;
  readonly expiresAt: Date | null;
  readonly messageCreatedAt: Date | null;
}

/** One canonical visibility read for a bounded live batch, including its current history and trusted source time. */
export const readLiveChannelAudience = async (
  executor: ChatDb,
  context: ChannelContext,
  userIds: readonly string[],
  messageId: string | undefined,
): Promise<readonly LiveChannelAuthority[]> => {
  if (userIds.length === 0) return [];
  if (userIds.length > LIVE_AUDIENCE_BATCH_MAX)
    throw new RangeError('Live audience batch is too large.');
  const access = visibleChannels(executor, sql.ref<string>('users.id'), { visibilityOnly: true })
    .select([
      'workspace_members.access_kind as accessKind',
      'workspace_members.guest_expires_at as expiresAt',
      sql<Date | null>`greatest(workspace_members.guest_since, channel_members.joined_at)`.as(
        'historySince',
      ),
    ])
    .where('channels.workspace_id', '=', context.workspaceId)
    .where('channels.id', '=', context.channelId)
    .as('live_access');
  return await audiencePeople(executor)
    .innerJoinLateral(access, (join) => join.onTrue())
    .select([
      'users.id as userId',
      'live_access.accessKind',
      'live_access.historySince',
      'live_access.expiresAt',
    ])
    .select((eb) =>
      messageId === undefined
        ? sql<Date | null>`null`.as('messageCreatedAt')
        : eb
            .selectFrom('messages as live_message')
            .select('live_message.created_at')
            .where('live_message.id', '=', messageId)
            .where('live_message.channel_id', '=', context.channelId)
            .where('live_message.workspace_id', '=', context.workspaceId)
            .$asScalar()
            .as('messageCreatedAt'),
    )
    .where('users.id', 'in', [...new Set(userIds)])
    .execute();
};

const visible = async (
  executor: ChatDb,
  userId: string,
  scope: Scope,
): Promise<readonly VisibleChannel[]> => {
  let query = visibleChannels(executor, userId, { visibilityOnly: true }).select([
    'channels.id as id',
    'channels.workspace_id as workspaceId',
    'channels.type as type',
    'workspaces.access_policy_epoch as policyEpoch',
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
  // Refuse every invisible resource before a policy hint can reveal anything about the visible ones.
  if (channelIds.some((id) => !byId.has(id))) throw channelNotFound();
  for (const [workspace, epoch] of new Map(
    found.map((row) => [row.workspaceId, row.policyEpoch]),
  )) {
    await requireWorkspaceContentAccess(executor, userId, workspace, epoch);
  }
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

/** Serialize collaboration writes with guest scope edits, then recheck after the channel lock wait. */
export const lockChannelForContentWrite = async (
  executor: ChatTx,
  context: ChannelContext,
): Promise<void> => {
  await executor
    .selectFrom('channels')
    .select('id')
    .where('id', '=', context.channelId)
    .where('workspace_id', '=', context.workspaceId)
    .forNoKeyUpdate()
    .execute();
  await requireChannelById(executor, context.userId, context.channelId);
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
): Promise<readonly ChannelContext[]> => {
  const channels = await visible(executor, context.userId, { workspaceId: context.workspaceId });
  const first = channels[0];
  if (first !== undefined)
    await requireWorkspaceContentAccess(
      executor,
      context.userId,
      context.workspaceId,
      first.policyEpoch,
    );
  return channels.map((channel) => mint(context.userId, channel));
};

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

/** Current message authority for a bound reader, including one bound by a batched replay row. */
export const messageHistoryVisibleTo = (
  executor: ChatDb,
  userId: string | RawBuilder<string>,
  workspaceId: string | RawBuilder<string>,
  message = 'messages',
): RawBuilder<boolean> => {
  const permitted = visibleChannels(executor, userId)
    .select('channels.id')
    .where('channels.workspace_id', '=', workspaceId)
    .where('channels.id', '=', sql.ref<string>(`${message}.channel_id`))
    .where(guestMessageHistoryFor(message));
  return sql<boolean>`exists (${permitted})`;
};

/** Apply the same live channel and history authority before a list's limit or cursor is computed. */
export const withinMessageHistory = (
  executor: ChatDb,
  context: WorkspaceContext | ChannelContext,
  message = 'messages',
): RawBuilder<boolean> =>
  messageHistoryVisibleTo(executor, context.userId, context.workspaceId, message);

/** Content projections use the same current authority as lists, even for captured full contexts. */
export const withinCurrentMessageHistory = (
  executor: ChatDb,
  context: WorkspaceContext | ChannelContext,
  message = 'messages',
): RawBuilder<boolean> => withinMessageHistory(executor, context, message);

/** Traversal only: older roots need a current readable continuation and must be projected separately. */
export const withinThreadHistory = (
  executor: ChatDb,
  context: WorkspaceContext | ChannelContext,
  message = 'messages',
): RawBuilder<boolean> => {
  const permitted = visibleChannels(executor, context.userId)
    .select('channels.id')
    .where('channels.workspace_id', '=', context.workspaceId)
    .where('channels.id', '=', sql.ref<string>(`${message}.channel_id`))
    .where(guestThreadHistoryFor(message));
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
  /** Only a thread container was authorized; its earlier content remains unavailable. */
  readonly historyHidden?: true;
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
  let statement = visibleChannels(executor, userId, { visibilityOnly: true })
    .innerJoin('messages', 'messages.channel_id', 'channels.id')
    .select([
      'channels.id as id',
      'channels.workspace_id as workspaceId',
      'channels.type as type',
      'workspaces.access_policy_epoch as policyEpoch',
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
  await requireWorkspaceContentAccess(executor, userId, row.workspaceId, row.policyEpoch);
  return {
    context: mint(userId, row),
    messageId,
    parentId: row.parentId,
  };
};

/** A feed/window/thread traversal capability; never use it for original-content actions or files. */
export const requireThreadContextById = async (
  executor: ChatDb,
  userId: string,
  messageId: string,
  options: { readonly deleted?: 'include' } = {},
): Promise<VisibleMessage> => {
  if (!Value.Check(Uuid, messageId)) throw messageNotFound();
  let statement = visibleChannels(executor, userId, { visibilityOnly: true })
    .innerJoin('messages', 'messages.channel_id', 'channels.id')
    .select([
      'channels.id as id',
      'channels.workspace_id as workspaceId',
      'channels.type as type',
      'workspaces.access_policy_epoch as policyEpoch',
      'workspace_members.guest_since as guestSince',
      'workspace_members.guest_expires_at as guestExpiresAt',
      'channel_members.joined_at as channelJoinedAt',
      'messages.parent_id as parentId',
    ])
    .select(guestMessageHistory.as('content_visible'))
    .where(guestThreadHistoryFor())
    .where('messages.id', '=', messageId);
  if (options.deleted !== 'include') statement = statement.where('messages.deleted_at', 'is', null);
  const row = await statement.executeTakeFirst();
  if (row === undefined) throw messageNotFound();
  await requireWorkspaceContentAccess(executor, userId, row.workspaceId, row.policyEpoch);
  return {
    context: mint(userId, row),
    messageId,
    parentId: row.parentId,
    ...(row.content_visible ? {} : { historyHidden: true as const }),
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
      'attachments.workspace_id as workspaceId',
      sql<string>`(select access_policy_epoch from workspaces where id = attachments.workspace_id)`.as(
        'policyEpoch',
      ),
    ])
    .where('attachments.id', '=', attachmentId)
    .where((eb) =>
      eb.or([
        isUnsentUploadOf(eb, userId, { visibilityOnly: true }),
        // Correlated, so it looks at this attachment's one message, not every visible one.
        eb.exists(
          visibleChannels(executor, userId, { visibilityOnly: true })
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
  await requireWorkspaceContentAccess(executor, userId, row.workspaceId, row.policyEpoch);
  return {
    id: row.id,
    storageKey: row.storageKey,
    thumbnailKey: row.thumbnailKey,
    fileName: row.fileName,
    kind: row.kind,
  };
};
