/**
 * Sending a message, and reading a page of them.
 *
 * The hot path. Two rules shape everything here.
 *
 * **The client supplies the id** (D-8), so the optimistic row and the durable row
 * share one value and a message never jumps when its acknowledgement lands. That
 * makes the id **untrusted input on a primary key**, and D-33 names three
 * permanent failures from trusting it: a wrong version orders a channel wrongly
 * forever, a future timestamp pins itself above everything *and* breaks keyset
 * pagination for every reader, and a bare `DO NOTHING` turns a send into an
 * existence oracle. All three are checked below.
 *
 * **Keyset, never `OFFSET`** (`SCHEMA.md` §6.3). `OFFSET` is O(n) and shifts
 * under concurrent inserts, which in a live channel is every page. The cursor is
 * the last id seen — no timestamp, no tie-break, because a UUIDv7 already sorts
 * by time and PostgreSQL compares `uuid` byte-wise.
 */
import type { Executor } from '@purlay/db';
import { isPlausibleMessageId, type Message, type MessagePage } from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { Clock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';

/** `API.md` §1: capped at 100, defaulting to 50. */
const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;

interface MessageRow {
  readonly id: string;
  readonly channel_id: string;
  readonly content: string;
  readonly edited_at: Date | string | null;
  readonly deleted_at: Date | string | null;
  readonly created_at: Date | string;
  readonly sender_id: string;
  readonly username: string;
  readonly display_name: string;
  readonly avatar_url: string | null;
}

const at = (value: Date | string): string => new Date(value).toISOString();

const asMessage = (row: MessageRow): Message => ({
  id: row.id,
  channelId: row.channel_id,
  sender: {
    id: row.sender_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  },
  content: row.content,
  editedAt: row.edited_at === null ? null : at(row.edited_at),
  deletedAt: row.deleted_at === null ? null : at(row.deleted_at),
  createdAt: at(row.created_at),
});

const COLUMNS = [
  'messages.id',
  'messages.channel_id',
  'messages.content',
  'messages.edited_at',
  'messages.deleted_at',
  'messages.created_at',
  'messages.sender_id',
  'users.username',
  'users.display_name',
  'users.avatar_url',
] as const;

const readMessage = async (
  executor: Executor,
  messageId: string,
): Promise<MessageRow | undefined> =>
  await executor
    .selectFrom('messages')
    .innerJoin('users', 'users.id', 'messages.sender_id')
    .select(COLUMNS)
    .where('messages.id', '=', messageId)
    .executeTakeFirst();

export interface OutgoingMessage {
  readonly id: string;
  readonly content: string;
}

/**
 * Writes the message, or recognises that it is already written.
 *
 * Idempotent for the sender who sent it: re-sending the same id in the same
 * channel returns the existing message, so a retry after a timeout can never
 * duplicate (D-8). Anyone *else's* id is a conflict that discloses nothing —
 * neither the sender, nor the channel, nor the content of what it collided with.
 */
export const sendMessage = async (
  executor: Executor,
  clock: Clock,
  context: ChannelContext,
  input: OutgoingMessage,
): Promise<Message> => {
  if (!isPlausibleMessageId(input.id, clock.now())) {
    throw new AppError({
      code: 'INVALID_MESSAGE_ID',
      message: 'That message id is not a UUIDv7 carrying a plausible timestamp.',
    });
  }

  const inserted = await executor
    .insertInto('messages')
    .values({
      id: input.id,
      workspace_id: context.workspaceId,
      channel_id: context.channelId,
      sender_id: context.userId,
      content: input.content,
      created_at: clock.now(),
    })
    .onConflict((conflict) => conflict.column('id').doNothing())
    .returning('id')
    .executeTakeFirst();

  if (inserted === undefined) {
    // Somebody's message already has this id. Whose, and where, decides whether
    // this is the retry D-8 designed for or a collision that must disclose
    // nothing — so the row is read back and compared rather than acknowledged.
    const existing = await readMessage(executor, input.id);
    const mine =
      existing?.sender_id === context.userId && existing.channel_id === context.channelId;
    if (!mine) {
      throw new AppError({
        code: 'MESSAGE_ID_CONFLICT',
        message: 'That message id is already in use.',
      });
    }
    return asMessage(existing);
  }

  // Denormalised so the sidebar can order channels without touching `messages`.
  await executor
    .updateTable('channels')
    .set({ last_message_at: clock.now() })
    .where('id', '=', context.channelId)
    .execute();

  const written = await readMessage(executor, input.id);
  if (written === undefined) {
    throw new AppError({ code: 'INTERNAL', message: 'Something went wrong.' });
  }
  return asMessage(written);
};

export interface HistoryQuery {
  /** Older than this id, newest first. */
  readonly before?: string | undefined;
  /** Newer than this id, **oldest first** — what a reconnect asks for (§5.4). */
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

/**
 * A page of root messages, newest first. `MessagePage` is the contract's shape,
 * not one redeclared here — a page is something a client parses, so its
 * definition belongs where every other wire shape is.
 *
 * Root messages only: replies belong to their thread and arrive with it.
 * Tombstoned messages are excluded from the feed but keep their place in the
 * thread they belong to (D-9), which is a thread-level concern rather than this
 * one's.
 */
export const messageHistory = async (
  executor: Executor,
  context: ChannelContext,
  query: HistoryQuery = {},
): Promise<MessagePage> => {
  if (query.before !== undefined && query.after !== undefined) {
    // Two directions at once has no meaning, and picking one silently is how a
    // client ends up reading a page it did not ask for and cannot tell.
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Ask for older or newer, not both.',
      details: { fields: { before: 'cannot be combined with `after`' } },
    });
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
  const forwards = query.after !== undefined;

  let statement = executor
    .selectFrom('messages')
    .innerJoin('users', 'users.id', 'messages.sender_id')
    .select(COLUMNS)
    .where('messages.channel_id', '=', context.channelId)
    .where('messages.parent_id', 'is', null)
    .where('messages.deleted_at', 'is', null)
    // Ascending when catching up, so a reconnect reads what it missed in the
    // order it happened and a client can append rather than sort (§5.4).
    .orderBy('messages.id', forwards ? 'asc' : 'desc')
    // One more than asked for: whether another page exists is answered by
    // reading, not by a second COUNT over the same rows.
    .limit(limit + 1);

  if (query.before !== undefined) statement = statement.where('messages.id', '<', query.before);
  if (query.after !== undefined) statement = statement.where('messages.id', '>', query.after);

  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  return {
    data: page.map(asMessage),
    // The cursor to pass back **in the direction you were travelling**: the last
    // id of this page, whichever end of the channel that is.
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};
