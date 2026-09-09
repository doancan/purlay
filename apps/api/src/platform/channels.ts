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
import { Uuid, type ChannelType } from '@purlay/types';
import type { Executor } from '@purlay/db';
import { AppError } from './errors';
import { requireWorkspaceMembership, type WorkspaceContext } from './tenancy';

/** Not exported. Naming this key is the capability, and it stays in this file. */
const visibility: unique symbol = Symbol('ChannelContext');

export interface ChannelContext {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: ChannelType;
  readonly userId: string;
  readonly [visibility]: true;
}

/**
 * **404, never 403.** Across this boundary the answer is the same whether the
 * channel is in another workspace, private and not yours, deleted, or was never
 * a channel at all — one value, so the four cannot drift apart (D-34).
 */
const channelNotFound = (): AppError =>
  new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' });

interface VisibleChannel {
  readonly id: string;
  readonly type: ChannelType;
}

/**
 * The one visibility rule.
 *
 * A public channel is visible to any member of its workspace. Anything else
 * requires a `channel_members` row. Written once here so the two entry points
 * below cannot answer differently.
 */
const canSee = async (
  executor: Executor,
  workspaceId: string,
  userId: string,
  channelId: string,
): Promise<VisibleChannel | undefined> => {
  if (!Value.Check(Uuid, channelId)) return undefined;

  const channel = await executor
    .selectFrom('channels')
    .select(['id', 'type'])
    .where('id', '=', channelId)
    .where('workspace_id', '=', workspaceId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (channel === undefined) return undefined;
  if (channel.type === 'public') return channel;

  const membership = await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', channelId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  return membership === undefined ? undefined : channel;
};

const mint = (context: WorkspaceContext, channel: VisibleChannel): ChannelContext => ({
  workspaceId: context.workspaceId,
  channelId: channel.id,
  channelType: channel.type,
  userId: context.userId,
  [visibility]: true,
});

/** For a caller that already holds a workspace context — the nested route shape. */
export const requireChannelVisibility = async (
  executor: Executor,
  context: WorkspaceContext,
  channelId: string,
): Promise<ChannelContext> => {
  const channel = await canSee(executor, context.workspaceId, context.userId, channelId);
  if (channel === undefined) throw channelNotFound();
  return mint(context, channel);
};

/**
 * For a route that names a channel and nothing else (`/api/channels/:channelId`).
 *
 * The workspace is derived from the resource and membership is verified before
 * anything about the channel is returned (`API.md` §1). The channel is looked up
 * first, to find out *which* workspace to check — and because every refusal is
 * the same value, that lookup tells a caller nothing it did not already supply.
 */
export const requireChannelById = async (
  executor: Executor,
  userId: string,
  channelId: string,
): Promise<ChannelContext> => {
  if (!Value.Check(Uuid, channelId)) throw channelNotFound();

  const owner = await executor
    .selectFrom('channels')
    .innerJoin('workspaces', 'workspaces.id', 'channels.workspace_id')
    .select('channels.workspace_id')
    .where('channels.id', '=', channelId)
    .where('channels.deleted_at', 'is', null)
    .where('workspaces.deleted_at', 'is', null)
    .executeTakeFirst();
  if (owner === undefined) throw channelNotFound();

  // A non-member of the workspace must not learn that this channel exists, so the
  // membership guard's own refusal is replaced by this boundary's.
  let context: WorkspaceContext;
  try {
    context = await requireWorkspaceMembership(executor, userId, owner.workspace_id);
  } catch {
    throw channelNotFound();
  }

  const channel = await canSee(executor, context.workspaceId, userId, channelId);
  if (channel === undefined) throw channelNotFound();
  return mint(context, channel);
};

/**
 * The channels this user can see, for a workspace-wide read.
 *
 * Search and the open-questions view narrow with `channel_id = ANY($1)` rather
 * than filtering after the fact — which is also what confines the trigram scan to
 * a few channels instead of the whole tenant (D-34).
 */
export const visibleChannelIds = async (
  executor: Executor,
  context: WorkspaceContext,
): Promise<readonly string[]> => {
  const rows = await executor
    .selectFrom('channels')
    .leftJoin('channel_members', (join) =>
      join
        .onRef('channel_members.channel_id', '=', 'channels.id')
        .on('channel_members.user_id', '=', context.userId),
    )
    .select('channels.id')
    .where('channels.workspace_id', '=', context.workspaceId)
    .where('channels.deleted_at', 'is', null)
    .where((eb) =>
      eb.or([eb('channels.type', '=', 'public'), eb('channel_members.user_id', 'is not', null)]),
    )
    .execute();
  return rows.map((row) => row.id);
};
