/**
 * A message's earlier versions (#82, D-135): what an edit replaced, kept in the edit's transaction,
 * read by anybody who can read the message, newest first, and removed one at a time by its author —
 * the remedy for a secret pasted and edited out, which would otherwise stay in the history for the
 * whole channel. A message keeps `MESSAGE_VERSIONS_KEPT`; past it, the oldest goes.
 *
 * Making a message a tombstone removes its versions with it (`tombstone.ts`), whoever does it — a
 * delete, the retention purge, content erasure: a tombstone hides what was said, and the cascade alone
 * would keep them, since the row stays (D-135 §4, D-139).
 */
import { Value } from '@sinclair/typebox/value';
import type { Executor } from '@purlay/db';
import {
  MESSAGE_VERSIONS_KEPT,
  messageId,
  messageIdTime,
  Uuid,
  type MessageVersionPage,
  type OlderPageQuery,
} from '@purlay/types';
import { messageNotFound, requireMessageById, type ChannelContext } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import { limitOf } from './threads';

const versionNotFound = (): AppError =>
  new AppError({ code: 'MESSAGE_VERSION_NOT_FOUND', message: 'Version not found.' });

/**
 * Keeps what an edit is replacing, under the lock the edit holds on the message's row, at the edit's
 * own instant; then lets the oldest go past the bound. One statement each, whatever the count.
 */
export const keepVersion = async (
  executor: Executor,
  context: ChannelContext,
  messageIdOf: string,
  replaced: string,
  now: Date,
): Promise<void> => {
  // After the newest, whatever the clock says: two edits in one millisecond, or a clock stepped back,
  // still list in the order they were made — the id is the order, `replaced_at` the time said.
  const newest = await executor
    .selectFrom('message_versions')
    .select('id')
    .where('message_id', '=', messageIdOf)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const at =
    newest === undefined ? now.getTime() : Math.max(now.getTime(), messageIdTime(newest.id) + 1);
  await executor
    .insertInto('message_versions')
    .values({
      id: messageId(new Date(at)),
      message_id: messageIdOf,
      channel_id: context.channelId,
      workspace_id: context.workspaceId,
      content: replaced,
      replaced_at: now,
    })
    .execute();
  await executor
    .deleteFrom('message_versions')
    .where('message_id', '=', messageIdOf)
    .where('id', 'not in', (eb) =>
      eb
        .selectFrom('message_versions')
        .select('id')
        .where('message_id', '=', messageIdOf)
        .orderBy('id', 'desc')
        .limit(MESSAGE_VERSIONS_KEPT),
    )
    .execute();
};

/** `GET /api/messages/:messageId/versions` — for anybody who can read the message. */
export const messageVersions = async (
  executor: Executor,
  userId: string,
  messageIdOf: string,
  query: OlderPageQuery,
): Promise<MessageVersionPage> => {
  await requireMessageById(executor, userId, messageIdOf);
  const limit = limitOf(query);
  let statement = executor
    .selectFrom('message_versions')
    .select(['id', 'content', 'replaced_at'])
    .where('message_id', '=', messageIdOf)
    .orderBy('id', 'desc')
    .limit(limit + 1);
  if (query.before !== undefined) statement = statement.where('id', '<', query.before);
  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  return {
    data: page.map((row) => ({
      id: row.id,
      content: row.content,
      replacedAt: new Date(row.replaced_at).toISOString(),
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};

/**
 * `DELETE /api/messages/:messageId/versions/:versionId` — the author's alone: their own words, taken
 * out of the history as an edit took them out of the message. Gone already is the same answer as
 * never there, so a retry after a lost answer is told the truth. The channel is answered so the
 * removal can be told to every open history once it has committed (D-135 §5).
 */
export const removeVersion = async (
  executor: Executor,
  userId: string,
  messageIdOf: string,
  versionId: string,
): Promise<{ readonly channelId: string }> => {
  const { context } = await requireMessageById(executor, userId, messageIdOf);
  const author = await executor
    .selectFrom('messages')
    .select('sender_id')
    .where('id', '=', messageIdOf)
    .executeTakeFirst();
  // Gone between the guard and here (a retention purge): the guard's answer, given late.
  if (author === undefined) throw messageNotFound();
  if (author.sender_id !== userId) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only the author removes an earlier version of a message.',
    });
  }
  // Not an id at all is the same as no such version — never a database error.
  if (!Value.Check(Uuid, versionId)) throw versionNotFound();
  const removed = await executor
    .deleteFrom('message_versions')
    .where('id', '=', versionId)
    .where('message_id', '=', messageIdOf)
    .returning('id')
    .executeTakeFirst();
  if (removed === undefined) throw versionNotFound();
  return { channelId: context.channelId };
};
