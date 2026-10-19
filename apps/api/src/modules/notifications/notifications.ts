/**
 * The inbox (D-106): what is waiting for a person in one workspace, newest first, and marking it
 * read.
 *
 * **Only from channels the person can see now** (D-34), narrowed in the query, and never about a
 * deleted message: the row is kept (D-103), the inbox does not show what nobody can read.
 *
 * **Reading here moves the badge too.** A channel's `unread_mention_count` is bounded by the
 * notifications still waiting in it (D-99 §4), so marking one read counts that channel's badge
 * again from the rows — the same expression the read position uses — and answers each channel where
 * one was newly read, for the caller's other devices to be told. The read position itself does not move: the
 * messages are still unread, they no longer need the person — except a reply the feed has already
 * been read past, which was unread only because its notification waited (D-147).
 *
 * **A thread is read here too** (D-147): opening it reads the caller's notifications for its
 * replies, by the same path, since that is all reading a thread changes.
 */
import { sql, type Executor, type RawBuilder, type Transaction } from '@purlay/db';
import type {
  ChannelState,
  NotificationPage,
  NotificationQuery,
  ReadNotificationsRequest,
  ReadThreadRequest,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireMessageById } from '../../platform/channels';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { waitingNotifications } from '../channels/read-state';
import { buildMessages, MESSAGE_COLUMNS } from '../messages/reader';
import { NEEDS_YOU } from '../messages/delivery';
import { limitOf } from '../messages/threads';

/** A channel with a notification newly read, as its row now is: what the caller's devices are told. */
export interface Told {
  readonly channelId: string;
  readonly state: ChannelState;
  readonly version: number;
}

const at = (value: Date | string): string => new Date(value).toISOString();

/**
 * Where a page stopped, as the row it names: the caller's own notification in this workspace, or a
 * refusal — an empty
 * page for a cursor that names nothing would look exactly like the end of the inbox.
 */
const cursorOf = async (
  executor: Executor,
  userId: string,
  workspaceId: string,
  id: string,
): Promise<RawBuilder<boolean>> => {
  const row = await executor
    .selectFrom('notifications')
    .select('id')
    .where('id', '=', id)
    .where('user_id', '=', userId)
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (row === undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'That is not one of your notifications.',
      details: { fields: { before: 'not one of your notifications in this workspace' } },
    });
  }
  // Compared in the database: its timestamps are finer than a JavaScript date, and a cursor that
  // went through one would sort after its own row.
  return sql<boolean>`(select n.created_at, n.message_id, n.id from notifications n where n.id = ${row.id})`;
};

/**
 * Newest first by when the person was told; at the same instant, by the message, which sorts by
 * time (UUIDv7); then by the notification's own id, so the order is total and a cursor exact.
 */
export const inboxOf = async (
  executor: Executor,
  context: WorkspaceContext,
  visible: readonly string[],
  query: NotificationQuery,
): Promise<NotificationPage> => {
  const limit = limitOf(query);
  const cursor =
    query.before === undefined
      ? undefined
      : await cursorOf(executor, context.userId, context.workspaceId, query.before);
  if (visible.length === 0) return { data: [], nextCursor: null };

  let statement = executor
    .selectFrom('notifications')
    .innerJoin('messages', 'messages.id', 'notifications.message_id')
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .select([
      'notifications.id as notification_id',
      'notifications.type as notification_type',
      'notifications.created_at as notified_at',
      'notifications.read_at as notification_read_at',
    ])
    .where('notifications.user_id', '=', context.userId)
    .where('notifications.workspace_id', '=', context.workspaceId)
    .where('notifications.channel_id', 'in', visible)
    .where('messages.deleted_at', 'is', null)
    .orderBy('notifications.created_at', 'desc')
    .orderBy('notifications.message_id', 'desc')
    .orderBy('notifications.id', 'desc')
    .limit(limit + 1);
  if (query.unreadOnly === true) statement = statement.where('notifications.read_at', 'is', null);
  if (cursor !== undefined) {
    statement = statement.where(
      sql<boolean>`(notifications.created_at, notifications.message_id, notifications.id) < ${cursor}`,
    );
  }

  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  const messages = await buildMessages(executor, page);
  return {
    data: page.map((row, index) => {
      const message = messages[index];
      // One message per row, in order (D-99 §8): a row without one would be dropped from the page
      // and skipped by the cursor, which looks exactly like a short page.
      if (message?.id !== row.id)
        throw new Error(`notification ${row.notification_id} lost its message`);
      return {
        id: row.notification_id,
        type: row.notification_type,
        channelId: row.channel_id,
        message,
        createdAt: at(row.notified_at),
        readAt: row.notification_read_at === null ? null : at(row.notification_read_at),
      };
    }),
    nextCursor: rows.length > limit ? (page.at(-1)?.notification_id ?? null) : null,
  };
};

/**
 * Marks the caller's notifications read — these ids, or a workspace's up to and including `before`
 * — and counts the badge again in every channel where one was newly read. Ids that are not the caller's are
 * not read and not reported: the answer is the same whether they exist or not.
 */
export const readNotifications = async (
  transaction: Transaction,
  clock: Clock,
  userId: string,
  input: ReadNotificationsRequest,
): Promise<readonly Told[]> => {
  let unread = transaction
    .selectFrom('notifications')
    .where('notifications.user_id', '=', userId)
    .where('notifications.read_at', 'is', null);
  if ('ids' in input) {
    unread = unread.where('notifications.id', 'in', input.ids);
  } else {
    const context = await requireWorkspaceMembership(transaction, userId, input.workspaceId);
    unread = unread.where('notifications.workspace_id', '=', context.workspaceId);
    if (input.before !== undefined) {
      const cursor = await cursorOf(transaction, userId, context.workspaceId, input.before);
      unread = unread.where(
        sql<boolean>`(notifications.created_at, notifications.message_id, notifications.id) <= ${cursor}`,
      );
    }
  }

  return await readAndCount(
    transaction,
    clock,
    userId,
    await unread.select(['notifications.id', 'notifications.channel_id']).execute(),
  );
};

/**
 * Reads the caller's notifications for the replies of one thread, up to and including
 * `lastReadMessageId` — what opening the thread reads (D-147). The root is asked of the guard first,
 * so a thread the caller cannot see is the stranger's `404`; a reply has no thread, as reading one
 * does not (`API.md` §5). Nothing else is stored: the bound is only a bound.
 */
export const readThreadNotifications = async (
  transaction: Transaction,
  clock: Clock,
  userId: string,
  rootId: string,
  input: ReadThreadRequest,
): Promise<readonly Told[]> => {
  // A deleted root with replies keeps its thread, and so what is waiting in it (D-103 §7).
  const root = await requireMessageById(transaction, userId, rootId, { deleted: 'include' });
  if (root.parentId !== null) {
    throw new AppError({ code: 'MESSAGE_NOT_FOUND', message: 'Message not found.' });
  }
  const targets = await transaction
    .selectFrom('notifications')
    .innerJoin('messages', 'messages.id', 'notifications.message_id')
    .select(['notifications.id', 'notifications.channel_id'])
    .where('notifications.user_id', '=', userId)
    .where('notifications.read_at', 'is', null)
    .where('messages.parent_id', '=', rootId)
    .where('notifications.message_id', '<=', input.lastReadMessageId)
    .execute();
  return await readAndCount(transaction, clock, userId, targets);
};

/** Marks these of the caller's notifications read and counts each channel touched again. */
const readAndCount = async (
  transaction: Transaction,
  clock: Clock,
  userId: string,
  targets: readonly { readonly id: string; readonly channel_id: string }[],
): Promise<readonly Told[]> => {
  if (targets.length === 0) return [];
  const touched = [...new Set(targets.map((row) => row.channel_id))].sort();

  // The memberships first, in one order, as the read position takes them: a read here and a read
  // of the channel at once take turns instead of each holding what the other waits for.
  await transaction
    .selectFrom('channel_members')
    .select('channel_id')
    .where('user_id', '=', userId)
    .where('channel_id', 'in', touched)
    .orderBy('channel_id')
    .forUpdate()
    .execute();
  // Only what this request read is told: a second device reading the same ids at once waited on
  // the lock above, finds them read, and has nothing to say.
  const newlyRead = await transaction
    .updateTable('notifications')
    .set({ read_at: clock.now() })
    .where(
      'id',
      'in',
      targets.map((row) => row.id),
    )
    .where('read_at', 'is', null)
    .returning(['id', 'channel_id'])
    .execute();
  const channelIds = [...new Set(newlyRead.map((row) => row.channel_id))];
  if (channelIds.length === 0) return [];

  // A reply at or behind the position was unread only because its notification waited (D-147):
  // read now, it is unread no longer. The rest are still unread messages past the position.
  const position = sql.ref('channel_members.last_read_message_id');
  const channel = sql.ref('channel_members.channel_id');
  const unread = sql<number>`greatest(unread_count - (
    select count(*)::int from notifications n
    join messages m on m.id = n.message_id and m.deleted_at is null and m.parent_id is not null
    where n.id = any(${newlyRead.map((row) => row.id)}::uuid[]) and n.channel_id = ${channel}
      and n.type in (${sql.join(NEEDS_YOU)}) and n.message_id <= ${position}
  ), 0)`;
  const rows = await transaction
    .updateTable('channel_members')
    .set({
      state_version: sql<number>`state_version + 1`,
      unread_count: unread,
      // The lesser of the two, as the read position counts it (I-6).
      unread_mention_count: sql<number>`least(${unread}, ${waitingNotifications(userId, channel)})`,
    })
    .where('user_id', '=', userId)
    .where('channel_id', 'in', channelIds)
    .returning([
      'channel_id',
      'last_read_message_id',
      'unread_count',
      'unread_mention_count',
      'state_version',
    ])
    .execute();
  return rows.map((row) => ({
    channelId: row.channel_id,
    version: row.state_version,
    state: {
      lastReadMessageId: row.last_read_message_id,
      unreadCount: row.unread_count,
      unreadMentionCount: row.unread_mention_count,
    },
  }));
};
