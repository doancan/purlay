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
import { sql, type Executor } from '@purlay/db';
import {
  SEARCH_QUERY_MIN,
  type MessagePage,
  type SearchQuery,
  type SearchCriteria,
} from '@purlay/types';
import { AppError } from '../../platform/errors';
import { channelNotFound } from '../../platform/channels';
import type { WorkspaceContext } from '../../platform/tenancy';
import { MESSAGE_COLUMNS } from '../messages/reader';
import { asPage, limitOf } from '../messages/threads';

/** `%`, `_` and `\` are what a person typed, not a pattern: escaped for `ILIKE`'s default escape. */
export const literalPattern = (words: string): string =>
  `%${words.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;

/** Filters can stand alone, but an unbounded empty search is never implicit. */
export const validateSearch = (query: SearchCriteria): void => {
  if (
    (query.q.length > 0 && query.q.trim().length < SEARCH_QUERY_MIN) ||
    (query.q.trim() === '' &&
      Object.keys(query).filter((key) => !['q', 'before', 'limit'].includes(key)).length === 0)
  ) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Enter search words or choose a filter.',
      details: { fields: { q: 'Choose a filter or enter at least three characters.' } },
    });
  }
  if (
    query.since !== undefined &&
    query.until !== undefined &&
    new Date(query.since) >= new Date(query.until)
  ) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The end must follow the start.',
      details: { fields: { until: 'Must be after the start.' } },
    });
  }
};

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
  validateSearch(query);
  if (query.channelId !== undefined && !visible.includes(query.channelId)) throw channelNotFound();
  const channelIds = query.channelId === undefined ? visible : [query.channelId];
  if (channelIds.length === 0) return { data: [], nextCursor: null };
  const limit = limitOf(query);

  let statement = executor
    .selectFrom('messages')
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .leftJoin('messages as parent', 'parent.id', 'messages.parent_id')
    .select(MESSAGE_COLUMNS)
    .where('messages.workspace_id', '=', context.workspaceId)
    .where('messages.channel_id', 'in', channelIds)
    .where('messages.deleted_at', 'is', null)
    .orderBy('messages.id', 'desc')
    .limit(limit + 1);
  if (query.q !== '') {
    const pattern = literalPattern(query.q);
    statement = statement.where((eb) =>
      eb.or([
        eb(
          sql<string>`purlay_fold(messages.content)`,
          'like',
          sql<string>`purlay_fold(${pattern})`,
        ),
        eb(
          sql<string>`purlay_fold(messages.decision_note)`,
          'like',
          sql<string>`purlay_fold(${pattern})`,
        ),
        eb.exists(
          eb
            .selectFrom('messages as answer')
            .select('answer.id')
            .whereRef('answer.id', '=', 'messages.accepted_answer_id')
            .whereRef('answer.parent_id', '=', 'messages.id')
            .where('answer.deleted_at', 'is', null)
            .where(
              sql<string>`purlay_fold(answer.content)`,
              'like',
              sql<string>`purlay_fold(${pattern})`,
            ),
        ),
      ]),
    );
  }
  if (query.question === 'yes') statement = statement.where('messages.is_question', '=', true);
  if (query.status !== undefined) {
    statement = statement.where(
      sql`coalesce(parent.resolved_at, messages.resolved_at)`,
      query.status === 'resolved' ? 'is not' : 'is',
      null,
    );
    if (query.status === 'open')
      statement = statement.where(sql<boolean>`
      (coalesce(parent.is_question, messages.is_question) OR coalesce(parent.thread_reply_count, messages.thread_reply_count) > 0)
    `);
  }
  if (query.since !== undefined)
    statement = statement.where('messages.created_at', '>=', new Date(query.since));
  if (query.until !== undefined)
    statement = statement.where('messages.created_at', '<', new Date(query.until));
  if (query.kind === 'code')
    statement = statement.where(
      sql<boolean>`jsonb_array_length(coalesce(messages.metadata->'codeLanguages', '[]'::jsonb)) > 0`,
    );
  if (query.kind === 'file')
    statement = statement.where((eb) =>
      eb.exists(
        eb
          .selectFrom('attachments')
          .select('attachments.id')
          .whereRef('attachments.message_id', '=', 'messages.id'),
      ),
    );
  if (query.repository !== undefined) {
    const repository = query.repository.toLowerCase();
    statement = statement.where(sql<boolean>`
      (lower(messages.metadata->>'repository') = ${repository}
      OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(messages.metadata->'githubLinks', '[]'::jsonb)) AS link(value)
        WHERE lower(split_part(link.value, '/', 4) || '/' || split_part(link.value, '/', 5)) = ${repository})
      OR (split_part(messages.decision_url, '/', 3) = 'github.com' AND
        lower(split_part(messages.decision_url, '/', 4) || '/' || split_part(messages.decision_url, '/', 5)) = ${repository}))
    `);
  }
  if (query.before !== undefined) statement = statement.where('messages.id', '<', query.before);
  // Who wrote it narrows the visible set further and never widens it (D-166): an author's words in a
  // channel the caller cannot see stay unseen, and a person of another workspace finds nothing here.
  if (query.senderId !== undefined) {
    statement = statement.where('messages.sender_id', '=', query.senderId);
  }

  return await asPage(executor, await statement.execute(), limit);
};
