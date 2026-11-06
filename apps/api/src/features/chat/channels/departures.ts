/**
 * Why a person is no longer in a channel, for the one thing that asks: the refusal of their own `SUBSCRIBE`
 * (D-264). A socket that was down when `ACCESS_REVOKED` was sent is told it again, to the person who was in
 * the channel and to nobody else — D-34 forbids telling anyone who was not why a channel is unavailable.
 *
 * Three ways out, three sources. An archive keeps the memberships (D-123 §2), so a person still in a channel
 * that is deleted was there when it was archived. Leaving and being taken out delete the membership, so each
 * leaves a row in `channel_departures`. Neither is read for a person who is not in the channel's workspace now,
 * and a membership that exists again outranks the row of an older departure.
 */
import { Value } from '@sinclair/typebox/value';
import { Uuid, type RevokedReason } from '@purlay/types';
import { sql, type SelectQueryBuilder } from '@purlay/db';
import type { ChatDb, ChatSchema } from '../schema';

export type Departure = Extract<RevokedReason, 'left' | 'removed'>;

/** Remembers how the person went, in the transaction that took the membership; the next departure replaces it. */
export const recordDeparture = async (
  executor: ChatDb,
  channelId: string,
  userId: string,
  reason: Departure,
): Promise<void> => {
  await executor
    .insertInto('channel_departures')
    .values({ channel_id: channelId, user_id: userId, reason })
    .onConflict((conflict) =>
      conflict.columns(['channel_id', 'user_id']).doUpdateSet({
        reason,
        departed_at: sql`now()`,
      }),
    )
    .execute();
};

/** The channels and the workspace membership that make a person's past in a channel theirs to be told. */
type StillInWorkspace = SelectQueryBuilder<
  ChatSchema,
  'channels' | 'workspaces' | 'workspace_members',
  object
>;

const inWorkspaceOf = (executor: ChatDb, userId: string): StillInWorkspace =>
  executor
    .selectFrom('channels')
    .innerJoin('workspaces', 'workspaces.id', 'channels.workspace_id')
    .innerJoin('workspace_members', (join) =>
      join
        .onRef('workspace_members.workspace_id', '=', 'channels.workspace_id')
        .on('workspace_members.user_id', '=', userId),
    )
    .where('workspaces.deleted_at', 'is', null);

/**
 * Of these channels, the ones the person was in and is not, each with why. Only a channel they were in is
 * named: asking about one they never were, or one that does not exist, yields the same nothing, in the same
 * single query, so the two cannot be told apart by what comes back or how long it takes.
 */
export const departuresFrom = async (
  executor: ChatDb,
  userId: string,
  channelIds: readonly string[],
): Promise<ReadonlyMap<string, RevokedReason>> => {
  // A value that is not a UUID raises on the cast; the guard has already refused it, and it names no channel.
  const asked = channelIds.filter((id) => Value.Check(Uuid, id));
  if (asked.length === 0) return new Map();
  const archived = inWorkspaceOf(executor, userId)
    .innerJoin('channel_members', (join) =>
      join
        .onRef('channel_members.channel_id', '=', 'channels.id')
        .on('channel_members.user_id', '=', userId),
    )
    .where('channels.id', 'in', asked)
    .where('channels.deleted_at', 'is not', null)
    .select(['channels.id as channelId', sql<string>`'archived'`.as('reason')]);
  const gone = inWorkspaceOf(executor, userId)
    .innerJoin('channel_departures', (join) =>
      join
        .onRef('channel_departures.channel_id', '=', 'channels.id')
        .on('channel_departures.user_id', '=', userId),
    )
    .where('channels.id', 'in', asked)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom('channel_members')
            .select('channel_members.user_id')
            .whereRef('channel_members.channel_id', '=', 'channels.id')
            .where('channel_members.user_id', '=', userId),
        ),
      ),
    )
    .select(['channels.id as channelId', 'channel_departures.reason as reason']);
  const rows = await archived.union(gone).execute();
  return new Map(rows.map((row) => [row.channelId, row.reason as RevokedReason]));
};
