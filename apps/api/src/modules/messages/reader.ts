/**
 * The one reader of messages (D-99 §8).
 *
 * History, a thread, the open-questions view, a replay, the answer to a send and the
 * frame the room receives all end in a `Message`, and they are built **here**, from
 * rows that came from the one column list below. A page that arrives by another
 * route therefore cannot say something different — a reaction missing from the
 * replay, a thread summary absent from the feed — because there is no other route.
 *
 * **A fixed number of queries per page, whatever its length.** The rows are the
 * caller's one query; this adds one for the reactions, one for the mentions and one
 * for the people who resolved threads, each over the whole page (and the last only
 * when the page has a resolved thread). A feed of fifty roots is four queries, not
 * two hundred — the rule D-13 states for counters, applied to every page.
 */
import type { Executor } from '@purlay/db';
import type { Message, Reaction, ThreadSummary, User } from '@purlay/types';
import { mentionSets, reactionSets } from './sets';

/** What every query that returns messages selects. Kept beside `MessageRow` so they cannot drift. */
export const MESSAGE_COLUMNS = [
  'messages.id',
  'messages.channel_id',
  'messages.content',
  'messages.edited_at',
  'messages.deleted_at',
  'messages.created_at',
  'messages.sender_id',
  'messages.parent_id',
  'messages.thread_reply_count',
  'messages.thread_last_reply_at',
  'messages.resolved_at',
  'messages.resolved_by',
  'users.username',
  'users.display_name',
  'users.avatar_url',
] as const;

export interface MessageRow {
  readonly id: string;
  readonly channel_id: string;
  readonly content: string;
  readonly edited_at: Date | string | null;
  readonly deleted_at: Date | string | null;
  readonly created_at: Date | string;
  readonly sender_id: string;
  readonly parent_id: string | null;
  readonly thread_reply_count: number;
  readonly thread_last_reply_at: Date | string | null;
  readonly resolved_at: Date | string | null;
  readonly resolved_by: string | null;
  readonly username: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
}

/** The columns that make up a thread's summary — also what a reply and a resolution update. */
export interface ThreadColumns {
  readonly thread_reply_count: number;
  readonly thread_last_reply_at: Date | string | null;
  readonly resolved_at: Date | string | null;
  readonly resolved_by: string | null;
}

export const at = (value: Date | string): string => new Date(value).toISOString();

const atOrNull = (value: Date | string | null): string | null =>
  value === null ? null : at(value);

/** The people with these ids, as the contract's `User` — one query, none when there are no ids. */
export const usersByIds = async (
  executor: Executor,
  ids: readonly string[],
): Promise<ReadonlyMap<string, User>> => {
  const people = new Map<string, User>();
  if (ids.length === 0) return people;
  const rows = await executor
    .selectFrom('users')
    .select(['id', 'username', 'display_name', 'avatar_url'])
    .where('id', 'in', ids)
    .execute();
  for (const row of rows) {
    people.set(row.id, {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    });
  }
  return people;
};

/**
 * A thread's summary from the columns that hold it.
 *
 * Both halves of a resolution are set or neither is (`resolution_is_complete`), so a
 * resolver the people lookup cannot find — an account erased since — still reads as
 * *resolved*, by nobody the client can name, rather than as open: a thread the team
 * closed does not reopen because a person left.
 */
export const summaryOf = (
  columns: ThreadColumns,
  people: ReadonlyMap<string, User>,
): ThreadSummary => ({
  replyCount: columns.thread_reply_count,
  lastReplyAt: atOrNull(columns.thread_last_reply_at),
  resolvedAt: atOrNull(columns.resolved_at),
  resolvedBy: columns.resolved_by === null ? null : (people.get(columns.resolved_by) ?? null),
});

/** One thread's summary, for the frame that announces a change to it. */
export const readSummary = async (
  executor: Executor,
  columns: ThreadColumns,
): Promise<ThreadSummary> =>
  summaryOf(
    columns,
    await usersByIds(executor, columns.resolved_by === null ? [] : [columns.resolved_by]),
  );

/** One message's row by id, with its sender; undefined when there is none. */
export const readMessage = async (
  executor: Executor,
  messageId: string,
): Promise<MessageRow | undefined> =>
  await executor
    .selectFrom('messages')
    .innerJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .where('messages.id', '=', messageId)
    .executeTakeFirst();

/** The contract's messages for these rows, in the order the rows came. */
export const buildMessages = async (
  executor: Executor,
  rows: readonly MessageRow[],
): Promise<Message[]> => {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const resolvers = rows.flatMap((row) => (row.resolved_by === null ? [] : [row.resolved_by]));
  const [reactions, mentions, people] = await Promise.all([
    reactionSets(executor, ids),
    mentionSets(executor, ids),
    usersByIds(executor, [...new Set(resolvers)]),
  ]);
  return rows.map((row) => ({
    id: row.id,
    channelId: row.channel_id,
    sender: {
      id: row.sender_id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    },
    content: row.content,
    editedAt: atOrNull(row.edited_at),
    deletedAt: atOrNull(row.deleted_at),
    createdAt: at(row.created_at),
    parentId: row.parent_id,
    // A reply has no summary of its own; a root always has one, with zero replies until it has some.
    thread: row.parent_id === null ? summaryOf(row, people) : null,
    reactions: [...(reactions.get(row.id) ?? [])] satisfies Reaction[],
    mentions: [...(mentions.get(row.id) ?? [])],
  }));
};

/** One message, built, so the answer to a write reads like the page it will appear on. */
export const readBuilt = async (
  executor: Executor,
  messageId: string,
): Promise<Message | undefined> => {
  const row = await readMessage(executor, messageId);
  if (row === undefined) return undefined;
  const [message] = await buildMessages(executor, [row]);
  return message;
};
