/**
 * A thread, read and closed: its replies, resolving it, and the workspace's open
 * questions (`UX.md` §4, D-99 §5).
 *
 * The resolvable thread is the product's argument, so the rules about it are
 * written once, here, and every door reaches them through the same functions.
 *
 * **Resolution is a fact about the root.** Any member who can see the channel may
 * close a thread or reopen it (`ARCHITECTURE.md` §7.4); only a root with at least
 * one reply can be closed (I-8) — a resolved question with no answer would be a
 * dismissal, and the database already refuses a reply that is resolved. The root row
 * is locked for the change, so two people resolving at once are two sequential
 * decisions and the second finds the thread already closed: a no-op that says so
 * with the message and publishes nothing, because nothing changed.
 */
import type { Executor } from '@purlay/db';
import { PAGE_LIMIT, type Message, type MessagePage } from '@purlay/types';
import { AppError } from '../../platform/errors';
import { requireMessageById, type VisibleMessage } from '../../platform/channels';
import type { Clock } from '../../platform/clock';
import type { WorkspaceContext } from '../../platform/tenancy';
import type { Atomically } from '../../platform/transactions';
import {
  NO_LOG,
  publishAfterCommit,
  publishThreadUpdated,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { requireLiveSession } from '../auth/sessions';
import { stillSeeing } from './delivery';
import { buildMessages, MESSAGE_COLUMNS, readBuilt, readSummary, type MessageRow } from './reader';

export interface PageQuery {
  readonly before?: string | undefined;
  readonly after?: string | undefined;
  readonly limit?: number | undefined;
}

const limitOf = (query: PageQuery): number =>
  Math.min(Math.max(query.limit ?? PAGE_LIMIT.default, 1), PAGE_LIMIT.max);

/** Two directions at once has no meaning, and picking one silently is how a client reads a page it did not ask for. */
const refuseBothDirections = (query: PageQuery): void => {
  if (query.before !== undefined && query.after !== undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Ask for older or newer, not both.',
      details: { fields: { before: 'cannot be combined with `after`' } },
    });
  }
};

/** A page of rows built into messages, and the cursor to continue in the direction travelled. */
const asPage = async (
  executor: Executor,
  rows: readonly MessageRow[],
  limit: number,
): Promise<MessagePage> => {
  const page = rows.slice(0, limit);
  return {
    data: await buildMessages(executor, page),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};

/**
 * A root's replies. **Oldest first** by default and with `after` — the order a thread
 * is read in, and the order a reconnecting client appends in — and newest first with
 * `before`, as every other page in this API is (`API.md` §1). Replies that were
 * tombstoned are not listed: `idx_messages_thread` is partial on live rows, and
 * deletion is not built yet (D-9 decides what a tombstone shows when it is).
 */
export const threadReplies = async (
  executor: Executor,
  root: VisibleMessage,
  query: PageQuery = {},
): Promise<MessagePage> => {
  // A reply has no thread: asking for one is asking for a message that is not there.
  if (root.parentId !== null) {
    throw new AppError({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' });
  }
  refuseBothDirections(query);
  const limit = limitOf(query);
  const backwards = query.before !== undefined;

  let statement = executor
    .selectFrom('messages')
    .innerJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .where('messages.parent_id', '=', root.messageId)
    .where('messages.deleted_at', 'is', null)
    .orderBy('messages.id', backwards ? 'desc' : 'asc')
    .limit(limit + 1);
  if (query.before !== undefined) statement = statement.where('messages.id', '<', query.before);
  if (query.after !== undefined) statement = statement.where('messages.id', '>', query.after);

  return await asPage(executor, await statement.execute(), limit);
};

/**
 * The open-questions view: roots with at least one reply and no resolution, from the
 * channels the caller can see and no others (D-34), newest first — backed by
 * `idx_messages_unresolved`.
 *
 * `channelIds` is the visible set the route asked the guard for. Narrowing by it, not
 * filtering afterwards, is what keeps a private conversation out of the answer and
 * also what confines the scan to a handful of channels.
 */
export const unresolvedIn = async (
  executor: Executor,
  context: WorkspaceContext,
  channelIds: readonly string[],
  query: PageQuery = {},
): Promise<MessagePage> => {
  refuseBothDirections(query);
  if (channelIds.length === 0) return { data: [], nextCursor: null };
  const limit = limitOf(query);
  const forwards = query.after !== undefined;

  let statement = executor
    .selectFrom('messages')
    .innerJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .where('messages.workspace_id', '=', context.workspaceId)
    .where('messages.channel_id', 'in', channelIds)
    .where('messages.parent_id', 'is', null)
    .where('messages.resolved_at', 'is', null)
    .where('messages.thread_reply_count', '>', 0)
    .where('messages.deleted_at', 'is', null)
    .orderBy('messages.id', forwards ? 'asc' : 'desc')
    .limit(limit + 1);
  if (query.before !== undefined) statement = statement.where('messages.id', '<', query.before);
  if (query.after !== undefined) statement = statement.where('messages.id', '>', query.after);

  return await asPage(executor, await statement.execute(), limit);
};

export interface ResolveDependencies {
  readonly atomically: Atomically;
  readonly clock: Clock;
  readonly bus: EventBus;
  /** Where a failed publish is written; the write it follows is already committed. */
  readonly log?: Logger;
}

const notResolvable = (message: string): AppError =>
  new AppError({ code: 'THREAD_NOT_RESOLVABLE', message });

/**
 * Closes or reopens a thread, and answers the root as it is now.
 *
 * Resolving tells the root's author (a `thread_resolved` notification, D-29) when
 * somebody else did it, and moves no counter: a resolution is not a message, so
 * counting it as one would put `unread_count` and what a recount finds in
 * disagreement (D-99 §1). The room hears `THREAD_UPDATED` after the commit and only
 * when something changed.
 */
export const setResolved = async (
  dependencies: ResolveDependencies,
  userId: string,
  messageId: string,
  resolved: boolean,
  sessionId?: string,
): Promise<Message> => {
  const { atomically, clock, bus, log = NO_LOG } = dependencies;
  const outcome = await atomically(async (transaction) => {
    if (sessionId !== undefined) await requireLiveSession(transaction, clock, sessionId);
    const target = await requireMessageById(transaction, userId, messageId);
    if (target.parentId !== null) {
      throw notResolvable('Only the message that started a thread can be resolved.');
    }

    // Locked, so a second resolver waits and then finds the thread already closed.
    const root = await transaction
      .selectFrom('messages')
      .select([
        'sender_id',
        'thread_reply_count',
        'thread_last_reply_at',
        'resolved_at',
        'resolved_by',
      ])
      .where('id', '=', messageId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    if (resolved && root.thread_reply_count === 0) {
      throw notResolvable('A thread with no replies has nothing to resolve.');
    }

    const changes = resolved ? root.resolved_at === null : root.resolved_at !== null;
    if (changes) {
      const now = clock.now();
      await transaction
        .updateTable('messages')
        .set(
          resolved
            ? { resolved_at: now, resolved_by: userId, updated_at: now }
            : { resolved_at: null, resolved_by: null, updated_at: now },
        )
        .where('id', '=', messageId)
        .execute();
      if (resolved && root.sender_id !== userId) {
        await notifyResolved(transaction, target, root.sender_id);
      }
    }

    const message = await readBuilt(transaction, messageId);
    const columns = await transaction
      .selectFrom('messages')
      .select(['thread_reply_count', 'thread_last_reply_at', 'resolved_at', 'resolved_by'])
      .where('id', '=', messageId)
      .executeTakeFirstOrThrow();
    if (message === undefined) {
      throw new AppError({ code: 'INTERNAL', message: 'Something went wrong.' });
    }
    return {
      message,
      changed: changes,
      channelId: target.context.channelId,
      summary: await readSummary(transaction, columns),
    };
  });

  if (outcome.changed) {
    await publishAfterCommit(log, [
      [
        {
          label: 'THREAD_UPDATED',
          run: async () =>
            await publishThreadUpdated(bus, clock, {
              channelId: outcome.channelId,
              messageId,
              thread: outcome.summary,
            }),
        },
      ],
    ]);
  }
  return outcome.message;
};

/**
 * The root's author is told their thread was closed — unless they muted the channel, or can
 * no longer see it: a notification row names a conversation, and somebody removed from a
 * private channel since asking must not learn it was resolved (D-34).
 */
const notifyResolved = async (
  executor: Executor,
  target: VisibleMessage,
  authorId: string,
): Promise<void> => {
  if (!(await stillSeeing(executor, target.context, [authorId])).has(authorId)) return;
  const membership = await executor
    .selectFrom('channel_members')
    .select('notification_level')
    .where('channel_id', '=', target.context.channelId)
    .where('user_id', '=', authorId)
    .executeTakeFirst();
  if (membership?.notification_level === 'none') return;
  await executor
    .insertInto('notifications')
    .values({
      user_id: authorId,
      workspace_id: target.context.workspaceId,
      channel_id: target.context.channelId,
      message_id: target.messageId,
      type: 'thread_resolved',
    })
    .onConflict((conflict) => conflict.columns(['user_id', 'message_id', 'type']).doNothing())
    .execute();
};
