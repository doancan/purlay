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
import { sql, type Executor } from '@purlay/db';
import {
  isMessageIdShape,
  isPlausibleMessageId,
  PAGE_LIMIT,
  type Message,
  type MessagePage,
  type ThreadSummary,
} from '@purlay/types';
import { AppError } from '../../platform/errors';
import { requireLiveSession } from '../auth/sessions';
import type { Clock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';
import {
  channelTopic,
  publishChannelState,
  publishThreadUpdated,
  type EventBus,
} from '../../platform/events';
import type { Atomically } from '../../platform/transactions';
import { recordDelivery, resolveMentions, type ChannelStateUpdate } from './delivery';
import { parseMentions } from './mentions';
import {
  buildMessages,
  MESSAGE_COLUMNS,
  readBuilt,
  readMessage,
  readSummary,
  type MessageRow,
} from './reader';

export interface OutgoingMessage {
  readonly id: string;
  readonly content: string;
  /** Makes this a reply to the root with this id, in this channel (I-1). */
  readonly parentId?: string | undefined;
}

/**
 * What a send did, so the caller can tell the room *after* the commit (D-35).
 *
 * `thread` is the root's summary when this was a reply — fresh for a retry too, so a
 * `THREAD_UPDATED` the first attempt never managed to publish is not lost with it.
 * `recipients` is only ever filled by the call that wrote the message: a retry did
 * not move a counter, and so has nothing to report.
 */
export interface Sent {
  readonly message: Message;
  readonly thread: { readonly rootId: string; readonly summary: ThreadSummary } | null;
  readonly recipients: readonly ChannelStateUpdate[];
}

/** The root a reply goes under, if it is a root of this channel that can be replied to. */
const requireRoot = async (
  executor: Executor,
  context: ChannelContext,
  parentId: string,
): Promise<{ readonly authorId: string }> => {
  const parent = await executor
    .selectFrom('messages')
    .select(['channel_id', 'parent_id', 'sender_id'])
    .where('id', '=', parentId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  // Another channel's message and none at all are one answer: which of the two it was
  // is what a caller who cannot see that channel must not learn (D-34).
  if (parent?.channel_id !== context.channelId) {
    throw new AppError({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' });
  }
  if (parent.parent_id !== null) {
    // Depth is a rule of the service, not of any one screen (I-1): no door offers a
    // reply under a reply, and a client that sends one anyway is told why.
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Threads are two levels deep: reply to the message that started it.',
      details: { fields: { parentId: 'is a reply, not the start of a thread' } },
    });
  }
  return { authorId: parent.sender_id };
};

/** The summary of a root's thread as it is now. */
const currentSummary = async (
  executor: Executor,
  rootId: string,
): Promise<ThreadSummary | undefined> => {
  const root = await executor
    .selectFrom('messages')
    .select(['thread_reply_count', 'thread_last_reply_at', 'resolved_at', 'resolved_by'])
    .where('id', '=', rootId)
    .executeTakeFirst();
  return root === undefined ? undefined : await readSummary(executor, root);
};

/**
 * Writes the message, or recognises that it is already written.
 *
 * Idempotent for the sender who sent it: re-sending the same id in the same
 * channel returns the existing message, so a retry after a timeout can never
 * duplicate (D-8) — nor count twice: the mentions, the notifications and the
 * counters are written only by the call that inserted the row. Anyone *else's* id is
 * a conflict that discloses nothing — neither the sender, nor the channel, nor the
 * content of what it collided with.
 */
export const sendMessage = async (
  executor: Executor,
  clock: Clock,
  context: ChannelContext,
  input: OutgoingMessage,
): Promise<Sent> => {
  const again = async (row: MessageRow): Promise<Sent> => {
    const [message] = await buildMessages(executor, [row]);
    if (message === undefined) {
      throw new AppError({ code: 'INTERNAL', message: 'Something went wrong.' });
    }
    const summary =
      row.parent_id === null ? undefined : await currentSummary(executor, row.parent_id);
    return {
      message,
      thread:
        row.parent_id === null || summary === undefined ? null : { rootId: row.parent_id, summary },
      recipients: [],
    };
  };

  if (!isPlausibleMessageId(input.id, clock.now())) {
    // A retry of a message that *was* written arrives late by nature: an outbox
    // drained after a long disconnect. The window guards new ids (D-33), not the
    // resend of one already stored, so the sender's own row in this channel is
    // returned as any retry's is (D-8). Anything else — a stranger's row, or none
    // — gets the same refusal for the same one query, so this path tells a prober
    // nothing about which ids exist (#198).
    const existing = isMessageIdShape(input.id) ? await readMessage(executor, input.id) : undefined;
    if (existing?.sender_id === context.userId && existing.channel_id === context.channelId) {
      return await again(existing);
    }
    throw new AppError({
      code: 'INVALID_MESSAGE_ID',
      message: 'That message id is not a UUIDv7 carrying a plausible timestamp.',
    });
  }

  // The parser's refusal (D-12): `@here` and its kin are not a thing this product has.
  const mentions = parseMentions(input.content);
  if (mentions.broadcast.length > 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Mention people by name: there is no @here, @channel or @everyone.',
      details: { fields: { content: 'broadcast mentions are not available' } },
    });
  }

  const root =
    input.parentId === undefined ? undefined : await requireRoot(executor, context, input.parentId);

  const inserted = await executor
    .insertInto('messages')
    .values({
      id: input.id,
      workspace_id: context.workspaceId,
      channel_id: context.channelId,
      sender_id: context.userId,
      parent_id: input.parentId ?? null,
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
    return await again(existing);
  }

  const sentAt = clock.now();

  // A reply moves its root's summary, in this transaction (`SCHEMA.md` §11: the
  // service keeps the counter equal to the rows). `greatest` so two repliers whose
  // clocks disagree cannot move the last reply back in time.
  let thread: Sent['thread'] = null;
  if (input.parentId !== undefined) {
    const summaryColumns = await executor
      .updateTable('messages')
      .set({
        thread_reply_count: sql<number>`thread_reply_count + 1`,
        thread_last_reply_at: sql<Date>`greatest(coalesce(thread_last_reply_at, ${sentAt}), ${sentAt})`,
      })
      .where('id', '=', input.parentId)
      .returning(['thread_reply_count', 'thread_last_reply_at', 'resolved_at', 'resolved_by'])
      .executeTakeFirstOrThrow();
    thread = { rootId: input.parentId, summary: await readSummary(executor, summaryColumns) };
  }

  // The mentions, the notifications and the counters: one place decides who is told (D-99 §1).
  const recipients = await recordDelivery(executor, {
    context,
    messageId: input.id,
    mentioned: await resolveMentions(executor, context, mentions.names),
    thread:
      input.parentId === undefined || root === undefined
        ? null
        : { rootId: input.parentId, rootAuthorId: root.authorId },
  });

  const written = await readBuilt(executor, input.id);
  if (written === undefined) {
    throw new AppError({ code: 'INTERNAL', message: 'Something went wrong.' });
  }

  // Denormalised so the sidebar can order channels without touching `messages`.
  //
  // Monotonic by construction: the row is written only when this message is newer
  // than what it holds, so two senders whose clocks disagree cannot move the
  // channel back, and a message that is not the newest costs no write and no row
  // lock. The column is in no index (migration 0008), so the write is a heap-only
  // update, and it comes last so the row lock it takes lives as short a time as
  // the transaction allows (D-88). Everything above commits with it, so where in the
  // transaction it sits changes nothing a reader can see — only how long it is held.
  await executor
    .updateTable('channels')
    .set({ last_message_at: sentAt })
    .where('id', '=', context.channelId)
    .where((eb) => eb.or([eb('last_message_at', 'is', null), eb('last_message_at', '<', sentAt)]))
    .execute();

  return { message: written, thread, recipients };
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

  const limit = Math.min(Math.max(query.limit ?? PAGE_LIMIT.default, 1), PAGE_LIMIT.max);
  const forwards = query.after !== undefined;

  let statement = executor
    .selectFrom('messages')
    .innerJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
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
    data: await buildMessages(executor, page),
    // The cursor to pass back **in the direction you were travelling**: the last
    // id of this page, whichever end of the channel that is.
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};

/** What one channel's replay returned, and where to continue it (`ReplayState`). */
export interface Replay {
  readonly data: readonly Message[];
  readonly nextCursor: string | null;
}

/**
 * Everything after each cursor, for several channels, in **one** query.
 *
 * A subscription names up to a hundred channels; one range query per channel was
 * a hundred round trips for one frame (#196). `unnest` pairs each channel with its
 * cursor and a lateral subquery reads each one's range by the primary key, oldest
 * first, one row past the limit so "is there more" is answered by reading.
 */
export const missedIn = async (
  executor: Executor,
  wanted: readonly { readonly context: ChannelContext; readonly after: string }[],
  perChannel: number,
): Promise<ReadonlyMap<string, Replay>> => {
  const replays = new Map<string, Replay>();
  if (wanted.length === 0) return replays;

  const rows = await executor
    .selectFrom(
      sql<{ channel_id: string; after_id: string }>`(
        select * from unnest(
          ${wanted.map((w) => w.context.channelId)}::uuid[],
          ${wanted.map((w) => w.after)}::uuid[]
        ) as pairs(channel_id, after_id)
      )`.as('wanted'),
    )
    .innerJoinLateral(
      (eb) =>
        eb
          .selectFrom('messages')
          .selectAll('messages')
          .whereRef('messages.channel_id', '=', 'wanted.channel_id')
          .whereRef('messages.id', '>', 'wanted.after_id')
          .where('messages.parent_id', 'is', null)
          .where('messages.deleted_at', 'is', null)
          .orderBy('messages.id', 'asc')
          .limit(perChannel + 1)
          .as('messages'),
      (join) => join.onTrue(),
    )
    .innerJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .orderBy('messages.channel_id')
    .orderBy('messages.id', 'asc')
    .execute();

  const byChannel = new Map<string, MessageRow[]>();
  for (const row of rows) {
    const list = byChannel.get(row.channel_id) ?? [];
    list.push(row);
    byChannel.set(row.channel_id, list);
  }
  // What is kept of each channel is built together: reactions and mentions for every
  // message of every channel are three queries, not three per channel (D-99 §8).
  const kept = wanted.map(({ context }) => ({
    context,
    list: byChannel.get(context.channelId) ?? [],
  }));
  const built = new Map(
    (
      await buildMessages(
        executor,
        kept.flatMap(({ list }) => list.slice(0, perChannel)),
      )
    ).map((message) => [message.id, message]),
  );
  for (const { context, list } of kept) {
    const page = list.slice(0, perChannel);
    replays.set(context.channelId, {
      data: page.flatMap((row) => {
        const message = built.get(row.id);
        return message === undefined ? [] : [message];
      }),
      nextCursor: list.length > perChannel ? (page.at(-1)?.id ?? null) : null,
    });
  }
  return replays;
};

export interface SendDependencies {
  readonly atomically: Atomically;
  readonly clock: Clock;
  readonly bus: EventBus;
}

/**
 * Sends a message: the one way, whichever door it came through.
 *
 * The socket and HTTP are two entry points to this function, not two code paths
 * (`ARCHITECTURE.md` §5.1). Before it existed the HTTP route wrote without a
 * transaction and published nothing, so a message sent while a socket was down
 * reached nobody until they reloaded.
 *
 * The order is load-bearing (D-35): everything the write touches commits
 * together; the room is told only after the commit returned, so nobody receives a
 * message that then rolls back; and the caller learns of it only after the room
 * has, so a sender is never ahead of the conversation.
 */
export const send = async (
  dependencies: SendDependencies,
  context: ChannelContext,
  input: OutgoingMessage,
  sessionId?: string,
): Promise<Message> => {
  const { atomically, clock, bus } = dependencies;
  const sent = await atomically(async (transaction) => {
    // The session the caller authenticated with, held live for this transaction (D-85).
    if (sessionId !== undefined) await requireLiveSession(transaction, clock, sessionId);
    return await sendMessage(transaction, clock, context, input);
  });
  // The room first, then what moved under it, then each person's own numbers: a
  // client that hears a reply has already heard the message, and one that hears a
  // count change has heard what changed it (D-99 §2).
  await bus.publish(channelTopic(context.channelId), {
    event: 'MESSAGE_CREATED',
    data: sent.message,
    ts: clock.now().getTime(),
  });
  if (sent.thread !== null) {
    await publishThreadUpdated(bus, clock, {
      channelId: context.channelId,
      messageId: sent.thread.rootId,
      thread: sent.thread.summary,
    });
  }
  for (const recipient of sent.recipients) {
    await publishChannelState(bus, clock, recipient.userId, context.channelId, recipient.state);
  }
  return sent.message;
};
