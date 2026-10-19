/**
 * What removing messages from a channel does, for any number of them at once (D-9, D-139 §2): the
 * tombstone's row change, and taking back what they added to the people they were counted for.
 *
 * One rule, three callers: a delete (one message, `delete.ts`), the retention purge and content
 * erasure (many). Kept here, set-based, so the purge and the erasure cannot drift from the delete —
 * a copy of `uncount` that missed the notifications would leave a mention counted for ever.
 */
import { sql, type Executor, type Transaction } from '@purlay/db';
import { NEEDS_YOU } from '@purlay/types';
import type { ChannelStateUpdate } from './delivery';
import { enqueueObjectDeletions } from '../attachments/deletions';

/** A message as the counters saw it when it was sent. */
export interface Counted {
  readonly id: string;
  /** Null for an event nobody wrote: it was counted for everybody (D-134 §6). */
  readonly senderId: string | null;
  readonly createdAt: Date;
}

/** A tombstone's row, as the room is told it. */
export interface Tombstoned {
  readonly id: string;
  readonly parentId: string | null;
  readonly editedAt: Date | null;
  readonly version: number;
}

/**
 * The tombstone (D-9): the words and what hangs off them go, the row stays. Nobody is named by a
 * message that says nothing; its pin goes with its words (D-130); and what it said before an edit
 * goes too, or the history would keep it readable (D-135 §4). Only messages not deleted already.
 */
export const tombstoneRows = async (
  executor: Executor,
  now: Date,
  messageIds: readonly string[],
): Promise<readonly Tombstoned[]> => {
  if (messageIds.length === 0) return [];
  const rows = await executor
    .updateTable('messages')
    .set({
      deleted_at: now,
      updated_at: now,
      // The client draws the words, in the reader's language (D-41).
      content: '',
      metadata: {},
      state_version: sql<number>`state_version + 1`,
    })
    .where('id', 'in', messageIds)
    .where('deleted_at', 'is', null)
    .returning(['id', 'state_version', 'parent_id', 'edited_at'])
    .execute();
  const removed = rows.map((row) => row.id);
  if (removed.length > 0) {
    await executor.deleteFrom('mentions').where('message_id', 'in', removed).execute();
    await executor.deleteFrom('pinned_messages').where('message_id', 'in', removed).execute();
    await executor.deleteFrom('message_versions').where('message_id', 'in', removed).execute();
  }
  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    editedAt: row.edited_at === null ? null : new Date(row.edited_at),
    version: row.state_version,
  }));
};

/**
 * Takes back what these messages of one channel added: what needed somebody no longer does — kept
 * for the inbox, read — and one unread for each member each message was counted for (not its author,
 * in the channel when it was written, with their position before it), and one unread mention for each
 * of them it was waiting on. Exactly what the sends added, so the stored numbers stay what a read would
 * recount them to. Called before a message is hard-deleted too: after, a read position on it is gone.
 *
 * Never below zero, and the mentions never above the unread (I-6): a message written before the
 * counters existed (0013) was never counted. The memberships are locked before the notifications, in
 * one order: reading a channel or the inbox takes them in that order too (D-106 §3).
 */
export const takeBack = async (
  executor: Executor,
  now: Date,
  channelId: string,
  messages: readonly Counted[],
): Promise<readonly ChannelStateUpdate[]> => {
  if (messages.length === 0) return [];
  await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', channelId)
    .orderBy('user_id')
    .forUpdate()
    .execute();
  const waiting = await executor
    .updateTable('notifications')
    .set({ read_at: now })
    .where(
      'message_id',
      'in',
      messages.map((message) => message.id),
    )
    .where('read_at', 'is', null)
    .where('type', 'in', NEEDS_YOU)
    .returning(['user_id', 'message_id'])
    .execute();

  const ids = messages.map((message) => message.id);
  const senders = messages.map((message) => message.senderId);
  const times = messages.map((message) => message.createdAt.toISOString());
  const waitedUsers = waiting.map((row) => row.user_id);
  const waitedMessages = waiting.map((row) => row.message_id);

  const changed = await sql<{
    user_id: string;
    last_read_message_id: string | null;
    unread_count: number;
    unread_mention_count: number;
    state_version: number;
  }>`
    update channel_members as member
    set
      unread_count = greatest(member.unread_count - taken.unread, 0),
      unread_mention_count = least(
        greatest(member.unread_mention_count - taken.mentions, 0),
        greatest(member.unread_count - taken.unread, 0)
      ),
      state_version = member.state_version + 1
    from (
      select
        counted.user_id,
        count(*)::int as unread,
        count(waited.user_id)::int as mentions
      from channel_members as counted
      join unnest(${ids}::uuid[], ${senders}::uuid[], ${times}::timestamptz[])
        as message(id, sender_id, created_at)
        on (message.sender_id is null or counted.user_id <> message.sender_id)
        and counted.joined_at <= message.created_at
        and (counted.last_read_message_id is null or counted.last_read_message_id < message.id)
      left join unnest(${waitedUsers}::uuid[], ${waitedMessages}::uuid[])
        as waited(user_id, message_id)
        on waited.user_id = counted.user_id and waited.message_id = message.id
      where counted.channel_id = ${channelId}
      group by counted.user_id
    ) as taken
    where member.channel_id = ${channelId} and member.user_id = taken.user_id
    returning
      member.user_id,
      member.last_read_message_id,
      member.unread_count,
      member.unread_mention_count,
      member.state_version
  `.execute(executor);
  return changed.rows.map((member) => ({
    userId: member.user_id,
    state: {
      lastReadMessageId: member.last_read_message_id,
      unreadCount: member.unread_count,
      unreadMentionCount: member.unread_mention_count,
    },
    version: member.state_version,
  }));
};

/** A message as removing it needs it: where, by whom, when, and whether it is deleted already. */
export interface RemovedRow {
  readonly id: string;
  readonly channel_id: string;
  readonly parent_id: string | null;
  readonly sender_id: string | null;
  readonly created_at: Date | string;
  readonly deleted_at: Date | string | null;
}

/** The columns a `RemovedRow` is read with. */
export const REMOVED_COLUMNS = [
  'id',
  'channel_id',
  'parent_id',
  'sender_id',
  'created_at',
  'deleted_at',
] as const;

/** Takes back what the live ones among these added, channel by channel. */
export const takeBackLive = async (
  transaction: Transaction,
  now: Date,
  rows: readonly RemovedRow[],
): Promise<void> => {
  const byChannel = new Map<string, Counted[]>();
  for (const row of rows) {
    // A deleted message's count was taken back when it was deleted.
    if (row.deleted_at !== null) continue;
    const counted = byChannel.get(row.channel_id) ?? [];
    counted.push({ id: row.id, senderId: row.sender_id, createdAt: new Date(row.created_at) });
    byChannel.set(row.channel_id, counted);
  }
  // In channel order, so two runs at once lock memberships in the same order.
  for (const channelId of [...byChannel.keys()].sort()) {
    await takeBack(transaction, now, channelId, byChannel.get(channelId) ?? []);
  }
};

/**
 * The files of these messages: rows deleted, their bytes off the workspace, their keys queued for the
 * store in the same transaction (D-141) and returned, for the caller to delete once it has committed.
 */
export const dropFiles = async (
  transaction: Transaction,
  workspaceId: string,
  messageIds: readonly string[],
): Promise<{ readonly count: number; readonly keys: readonly string[] }> => {
  if (messageIds.length === 0) return { count: 0, keys: [] };
  const gone = await transaction
    .deleteFrom('attachments')
    .where('message_id', 'in', messageIds)
    .returning(['size_bytes', 'storage_key', 'thumbnail_key'])
    .execute();
  if (gone.length > 0) {
    const bytes = gone.reduce((sum, row) => sum + BigInt(row.size_bytes), 0n);
    await transaction
      .updateTable('workspaces')
      .set({
        storage_used_bytes: sql<string>`greatest(storage_used_bytes - ${bytes.toString()}::bigint, 0)`,
      })
      .where('id', '=', workspaceId)
      .execute();
  }
  const keys = gone.flatMap((row) =>
    row.thumbnail_key === null ? [row.storage_key] : [row.storage_key, row.thumbnail_key],
  );
  await enqueueObjectDeletions(transaction, keys);
  return { count: gone.length, keys };
};

/** The memberships of these channels, locked in one order: channel, then person (D-106 §3). */
export const lockMemberships = async (
  transaction: Transaction,
  channelIds: readonly string[],
): Promise<void> => {
  if (channelIds.length === 0) return;
  await transaction
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', 'in', channelIds)
    .orderBy('channel_id')
    .orderBy('user_id')
    .forUpdate()
    .execute();
};

/** The channels these rows are in, in one order. */
export const channelsOf = (rows: readonly { readonly channel_id: string }[]): string[] =>
  [...new Set(rows.map((row) => row.channel_id))].sort();
