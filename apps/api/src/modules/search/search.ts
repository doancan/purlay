/**
 * Searching a workspace's messages (D-105, D-10): the words as typed, ignoring case, anywhere in a
 * message — roots and replies, open threads and resolved ones — newest first, a page at a time.
 *
 * **Only in the channels the caller can see** (D-34). `channelIds` is the visible set the route asked
 * the guard for; the query is narrowed by it, never filtered afterwards, so a private conversation
 * cannot reach the answer even for a moment. A deleted message is not found: its words are not on
 * any screen, and search must not be the way back to them (D-103).
 *
 * The match is `LIKE` on both sides folded — case ignored by Unicode, I ı İ i one letter (#700) —
 * backed by the trigram index `idx_messages_search_folded` on the same expression, which is why a
 * search is at least three characters (`SEARCH_QUERY_MIN`): below a trigram the index cannot help.
 */
import { notHiddenBy } from '../messages/hidden';
import { sql, type Executor } from '@purlay/db';
import type { MessagePage, SearchQuery } from '@purlay/types';
import { channelNotFound } from '../../platform/channels';
import type { WorkspaceContext } from '../../platform/tenancy';
import { MESSAGE_COLUMNS } from '../messages/reader';
import { asPage, limitOf } from '../messages/threads';

/** `%`, `_` and `\` are what a person typed, not a pattern: escaped for `ILIKE`'s default escape. */
const literalPattern = (words: string): string =>
  `%${words.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/**
 * `channelIds` is every channel the caller can see in the workspace. `query.channelId` narrows the
 * search to one of them; a channel outside that set — another workspace's, or one the caller is not
 * in — is the same `CHANNEL_NOT_FOUND` as anywhere else, never an empty answer that confirms it.
 * `query.senderId` narrows it to one person's words (D-166), on `idx_messages_sender` or the trigram
 * index, whichever the planner finds the smaller.
 */
export const searchIn = async (
  executor: Executor,
  context: WorkspaceContext,
  visible: readonly string[],
  query: SearchQuery,
): Promise<MessagePage> => {
  if (query.channelId !== undefined && !visible.includes(query.channelId)) throw channelNotFound();
  const channelIds = query.channelId === undefined ? visible : [query.channelId];
  if (channelIds.length === 0) return { data: [], nextCursor: null };
  const limit = limitOf(query);

  let statement = executor
    .selectFrom('messages')
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .where('messages.workspace_id', '=', context.workspaceId)
    .where('messages.channel_id', 'in', channelIds)
    .where('messages.deleted_at', 'is', null)
    .where(notHiddenBy(context.userId))
    // Case folded by Unicode on both sides, I ı İ i as one letter (#700), through the expression
    // `idx_messages_search_folded` is built on.
    .where(
      sql<string>`purlay_fold(messages.content)`,
      'like',
      sql<string>`purlay_fold(${literalPattern(query.q)})`,
    )
    .orderBy('messages.id', 'desc')
    .limit(limit + 1);
  if (query.before !== undefined) statement = statement.where('messages.id', '<', query.before);
  // Who wrote it narrows the visible set further and never widens it (D-166): an author's words in a
  // channel the caller cannot see stay unseen, and a person of another workspace finds nothing here.
  if (query.senderId !== undefined) {
    statement = statement.where('messages.sender_id', '=', query.senderId);
  }

  return await asPage(executor, await statement.execute(), limit);
};
