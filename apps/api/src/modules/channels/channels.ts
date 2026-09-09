/**
 * Channels: create a public one, join it, list what you can see.
 *
 * Every function takes a context rather than an id — a `WorkspaceContext` for
 * what belongs to the workspace, a `ChannelContext` for what belongs to one
 * channel. A caller cannot hold either without having been checked, so an
 * unscoped query does not compile (D-21, D-34).
 *
 * **Public channels only in this phase.** Private channels and DMs are Phase 1;
 * the *visibility rule* that governs them is already written and enforced by the
 * guard, so what is missing here is the endpoint that creates them, not the
 * protection.
 */
import type { Executor } from '@purlay/db';
import type { Channel } from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { Clock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';
import { visibleChannelIds } from '../../platform/channels';
import type { WorkspaceContext } from '../../platform/tenancy';

interface ChannelRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string | null;
  readonly topic: string | null;
  readonly type: Channel['type'];
  readonly last_message_at: Date | string | null;
}

const asChannel = (row: ChannelRow): Channel => ({
  id: row.id,
  workspaceId: row.workspace_id,
  name: row.name,
  topic: row.topic,
  type: row.type,
  lastMessageAt: row.last_message_at === null ? null : new Date(row.last_message_at).toISOString(),
});

const COLUMNS = ['id', 'workspace_id', 'name', 'topic', 'type', 'last_message_at'] as const;

export interface NewChannel {
  readonly name: string;
  readonly topic?: string | undefined;
}

/**
 * Creates a public channel and puts its creator in it.
 *
 * The name is checked before the insert so a duplicate is a `409` a person can
 * act on rather than a unique-violation surfacing as a `500`. The index is still
 * the authority — this check races, and losing the race is what the constraint is
 * for.
 */
export const createChannel = async (
  executor: Executor,
  clock: Clock,
  context: WorkspaceContext,
  input: NewChannel,
): Promise<Channel> => {
  const taken = await executor
    .selectFrom('channels')
    .select('id')
    .where('workspace_id', '=', context.workspaceId)
    .where((eb) => eb(eb.fn('lower', ['name']), '=', input.name.toLowerCase()))
    .where('type', '!=', 'direct_message')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (taken !== undefined) {
    throw new AppError({
      code: 'CHANNEL_NAME_TAKEN',
      message: 'A channel with that name already exists here.',
    });
  }

  const row = await executor
    .insertInto('channels')
    .values({
      workspace_id: context.workspaceId,
      name: input.name,
      ...(input.topic === undefined ? {} : { topic: input.topic }),
      type: 'public',
      created_by: context.userId,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();

  await executor
    .insertInto('channel_members')
    .values({ channel_id: row.id, user_id: context.userId, joined_at: clock.now() })
    .execute();

  return asChannel(row);
};

/**
 * The channels this user can see, newest activity first.
 *
 * Narrowed by `id = ANY(…)` from the visibility guard rather than filtered after
 * the fact, which is the shape D-34 requires of every workspace-wide read.
 */
export const channelsVisibleIn = async (
  executor: Executor,
  context: WorkspaceContext,
): Promise<readonly Channel[]> => {
  const visible = await visibleChannelIds(executor, context);
  if (visible.length === 0) return [];

  const rows = await executor
    .selectFrom('channels')
    .select(COLUMNS)
    .where('id', 'in', visible)
    // `NULLS LAST` because PostgreSQL sorts nulls *first* under `DESC`: without
    // it a channel nobody has written in yet ranks above every active one, which
    // is the opposite of what `UX.md` §4 asks the sidebar to show.
    .orderBy('last_message_at', (order) => order.desc().nullsLast())
    .orderBy('name', 'asc')
    .execute();
  return rows.map(asChannel);
};

/** The channel the context was minted for. There is no other one it could return. */
export const channelIn = async (executor: Executor, context: ChannelContext): Promise<Channel> => {
  const row = await executor
    .selectFrom('channels')
    .select(COLUMNS)
    .where('id', '=', context.channelId)
    .executeTakeFirstOrThrow();
  return asChannel(row);
};

/**
 * Joins a channel you can already see.
 *
 * Public only in this phase, and joining twice is not an error: the outcome asked
 * for is already true, and a `409` here would make a retry after a dropped
 * response look like a failure.
 */
export const joinChannel = async (
  executor: Executor,
  clock: Clock,
  context: ChannelContext,
): Promise<void> => {
  if (context.channelType !== 'public') {
    // Not reachable through the guard today — a non-public channel is only visible
    // to somebody already in it — but the endpoint says *public only*, so it says
    // so here rather than relying on that remaining true.
    throw new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' });
  }
  await executor
    .insertInto('channel_members')
    .values({ channel_id: context.channelId, user_id: context.userId, joined_at: clock.now() })
    .onConflict((conflict) => conflict.columns(['channel_id', 'user_id']).doNothing())
    .execute();
};
