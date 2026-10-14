/**
 * A person's saved messages (#484, D-128): a message kept to come back to, in progress, archived
 * or completed. Each is the person's own; nothing about it reaches anybody else.
 *
 * - **Only what they can read.** Saving and unsaving find the message through the caller's visible
 *   channels in one query (`requireMessageById`); the lists show only saves in channels they can
 *   still see, of messages not deleted — as the inbox does. A save in a channel they left is kept,
 *   not shown, and not counted.
 * - **At most `SAVED_MAX` a workspace**, counted over what is shown, under the person's membership
 *   row locked: two saves racing at the bound cannot both be the last. Saving again is never refused.
 * - **Saving again keeps what was there**: its id, its time, and its state unless a state is given —
 *   so a second Save never undoes "completed".
 */
import {
  sql,
  type Database,
  type Executor,
  type SelectQueryBuilder,
  type Transaction,
} from '@purlay/db';
import {
  messageId as newId,
  SAVED_MAX,
  type SaveMessageRequest,
  type SavedIds,
  type SavedPage,
  type SavedQuery,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { requireMessageById, visibleChannelIds } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { buildMessages, MESSAGE_COLUMNS } from '../messages/reader';
import { limitOf } from '../messages/threads';

const at = (value: Date | string): string => new Date(value).toISOString();

/** The saves a person is shown in a workspace: in a channel they can see, of a message not deleted. */
const shown = (
  executor: Executor,
  context: Pick<WorkspaceContext, 'userId' | 'workspaceId'>,
  visible: readonly string[],
): SelectQueryBuilder<Database, 'saved_messages' | 'messages', object> =>
  executor
    .selectFrom('saved_messages')
    .innerJoin('messages', 'messages.id', 'saved_messages.message_id')
    .where('saved_messages.user_id', '=', context.userId)
    .where('saved_messages.workspace_id', '=', context.workspaceId)
    .where('saved_messages.channel_id', 'in', visible)
    .where('messages.deleted_at', 'is', null);

/** Saves the message, or moves its save to `input.state`. Answers the workspace it is in. */
export const saveMessage = async (
  transaction: Transaction,
  clock: Clock,
  userId: string,
  messageId: string,
  input: SaveMessageRequest,
): Promise<string> => {
  const { context } = await requireMessageById(transaction, userId, messageId);
  // The membership row, as the bound's lock: a second save at the bound waits for this one.
  await transaction
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  const existing = await transaction
    .selectFrom('saved_messages')
    .select('id')
    .where('user_id', '=', userId)
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  if (existing !== undefined) {
    if (input.state !== undefined) {
      await transaction
        .updateTable('saved_messages')
        .set({ state: input.state, updated_at: clock.now() })
        .where('id', '=', existing.id)
        .execute();
    }
    return context.workspaceId;
  }
  const workspace = await requireWorkspaceMembership(transaction, userId, context.workspaceId);
  const visible = await visibleChannelIds(transaction, workspace);
  const counted = await shown(transaction, workspace, visible)
    .select(sql<number>`count(*)::int`.as('count'))
    .executeTakeFirstOrThrow();
  if (counted.count >= SAVED_MAX) {
    throw new AppError({
      code: 'SAVED_LIMIT',
      message: `At most ${String(SAVED_MAX)} saved messages a workspace; complete or remove some first.`,
    });
  }
  await transaction
    .insertInto('saved_messages')
    .values({
      id: newId(clock.now()),
      user_id: userId,
      workspace_id: context.workspaceId,
      channel_id: context.channelId,
      message_id: messageId,
      state: input.state ?? 'in_progress',
      saved_at: clock.now(),
      updated_at: clock.now(),
    })
    .execute();
  return context.workspaceId;
};

/** Forgets the save, if there is one; a deleted message's save can still be let go. */
export const unsaveMessage = async (
  executor: Executor,
  userId: string,
  messageId: string,
): Promise<string> => {
  const { context } = await requireMessageById(executor, userId, messageId, { deleted: 'include' });
  await executor
    .deleteFrom('saved_messages')
    .where('user_id', '=', userId)
    .where('message_id', '=', messageId)
    .execute();
  return context.workspaceId;
};

/** One state's saves, newest saved first; keyset on the save's own id, which time orders. */
export const savedPage = async (
  executor: Executor,
  context: WorkspaceContext,
  query: SavedQuery,
): Promise<SavedPage> => {
  const visible = await visibleChannelIds(executor, context);
  if (visible.length === 0) return { data: [], nextCursor: null };
  const limit = limitOf(query);
  let statement = shown(executor, context, visible)
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .select([
      'saved_messages.id as save_id',
      'saved_messages.state as save_state',
      'saved_messages.saved_at as saved_at',
    ])
    .where('saved_messages.state', '=', query.state)
    .orderBy('saved_messages.id', 'desc')
    .limit(limit + 1);
  if (query.before !== undefined)
    statement = statement.where('saved_messages.id', '<', query.before);
  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  const messages = await buildMessages(executor, page);
  return {
    data: page.map((row, index) => {
      const message = messages[index];
      // One message per row, in order: a row without one would vanish and look like a short page.
      if (message?.id !== row.id) throw new Error(`save ${row.save_id} lost its message`);
      return { id: row.save_id, state: row.save_state, savedAt: at(row.saved_at), message };
    }),
    nextCursor: rows.length > limit ? (page.at(-1)?.save_id ?? null) : null,
  };
};

/** Which messages the person has saved here, to mark them where they are read. */
export const savedIds = async (
  executor: Executor,
  context: WorkspaceContext,
): Promise<SavedIds> => {
  const visible = await visibleChannelIds(executor, context);
  if (visible.length === 0) return [];
  return await shown(executor, context, visible)
    .select([
      'saved_messages.message_id as messageId',
      'saved_messages.channel_id as channelId',
      'saved_messages.state as state',
    ])
    .orderBy('saved_messages.id', 'desc')
    .limit(SAVED_MAX)
    .execute();
};
