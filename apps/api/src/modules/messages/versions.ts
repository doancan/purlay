/**
 * A message's earlier versions (#82, D-135): what an edit replaced, kept in the edit's transaction,
 * read by anybody who can read the message, newest first, and removed one at a time by its author —
 * the remedy for a secret pasted and edited out, which would otherwise stay in the history for the
 * whole channel. A message keeps `MESSAGE_VERSIONS_KEPT`; past it, the oldest goes.
 *
 * Deleting a message removes its versions with it (`delete.ts`): a tombstone hides what was said.
 * TODO(#83): erasure tombstones a person's messages rather than deleting the rows, so it must remove
 * their versions as `delete.ts` does — the cascade alone would keep them (D-135 §4).
 */
import { Value } from '@sinclair/typebox/value';
import type { Executor } from '@purlay/db';
import {
  MESSAGE_VERSIONS_KEPT,
  messageId,
  Uuid,
  type MessageVersionPage,
  type OlderPageQuery,
} from '@purlay/types';
import { requireMessageById, type ChannelContext } from '../../platform/channels';
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
  await executor
    .insertInto('message_versions')
    .values({
      id: messageId(now),
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
 * never there, so a retry after a lost answer is told the truth.
 */
export const removeVersion = async (
  executor: Executor,
  userId: string,
  messageIdOf: string,
  versionId: string,
): Promise<void> => {
  await requireMessageById(executor, userId, messageIdOf);
  const author = await executor
    .selectFrom('messages')
    .select('sender_id')
    .where('id', '=', messageIdOf)
    .executeTakeFirstOrThrow();
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
};
