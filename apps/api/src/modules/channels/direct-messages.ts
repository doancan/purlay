/**
 * Opening a direct message: the same pair always gets the same channel (I-5, D-99 §7).
 *
 * The pair is the channel's identity, not a lookup that happens to find one. The
 * key is the two ids sorted and joined, the database refuses any other form, and a
 * unique index on `(workspace_id, dm_key)` makes a second channel between the same
 * two people impossible — so two calls racing each other cannot make two. The
 * insert is `ON CONFLICT DO NOTHING` and the loser reads the winner's row, which
 * is visible by then because the conflict waits for the winner to commit.
 *
 * A note to self is a direct message whose two ids are the same, with one member.
 */
import type { Transaction } from '@purlay/db';
import type { Channel } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { WorkspaceContext } from '../../platform/tenancy';
import { channelFor } from './channels';
import { requireWorkspacePerson } from './members';

export interface OpenedDirectMessage {
  /** As the caller sees it. */
  readonly channel: Channel;
  /**
   * As the other person sees it, only when this call created the channel — what
   * their sockets are told, after the commit, so the conversation exists for them
   * without a reload. Null when it already existed, and for a note to self.
   */
  readonly forPeer: Channel | null;
  /** True when this call made the channel, a note to self included. */
  readonly created: boolean;
}

/** The pair, sorted: what `dm_key` holds and the database checks the form of (I-5). */
export const directMessageKey = (a: string, b: string): string =>
  a <= b ? `${a}:${b}` : `${b}:${a}`;

export const openDirectMessage = async (
  executor: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  peerId: string,
): Promise<OpenedDirectMessage> => {
  await requireWorkspacePerson(executor, context, peerId);

  const dmKey = directMessageKey(context.userId, peerId);
  const inserted = await executor
    .insertInto('channels')
    .values({
      workspace_id: context.workspaceId,
      type: 'direct_message',
      dm_key: dmKey,
      created_by: context.userId,
    })
    .onConflict((conflict) =>
      conflict.columns(['workspace_id', 'dm_key']).where('type', '=', 'direct_message').doNothing(),
    )
    .returning('id')
    .executeTakeFirst();

  const channelId =
    inserted?.id ??
    (
      await executor
        .selectFrom('channels')
        .select('id')
        .where('workspace_id', '=', context.workspaceId)
        .where('dm_key', '=', dmKey)
        .where('type', '=', 'direct_message')
        .executeTakeFirstOrThrow()
    ).id;

  // Both are members whether the channel is new or not: a membership that is
  // already there is left alone, and one that is somehow missing is restored, so a
  // direct message can never exist that one of its two people cannot open.
  const members = [...new Set([context.userId, peerId])].map((userId) => ({
    channel_id: channelId,
    user_id: userId,
    joined_at: clock.now(),
  }));
  await executor
    .insertInto('channel_members')
    .values(members)
    .onConflict((conflict) => conflict.columns(['channel_id', 'user_id']).doNothing())
    .execute();

  const channel = await channelFor(executor, context.userId, channelId);
  const forPeer =
    inserted === undefined || peerId === context.userId
      ? null
      : await channelFor(executor, peerId, channelId);
  return { channel, forPeer, created: inserted !== undefined };
};
