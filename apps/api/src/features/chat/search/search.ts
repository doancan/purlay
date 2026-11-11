/**
 * Searching a workspace's messages (D-105, D-10): the words as typed, ignoring case, anywhere in a
 * message — roots and replies, open threads and resolved ones — newest first, a page at a time.
 *
 * **Only in the channels the caller can see** (D-34). `channelIds` is the visible set the route asked
 * the guard for; the query is narrowed by it, never filtered afterwards, so a private conversation
 * cannot reach the answer even for a moment. A deleted message is not found: its words are not on
 * any screen, and search must not be the way back to them (D-103).
 *
 * The match is `LIKE` on both sides folded — case ignored by Unicode, I ı İ i one letter (#700) — in
 * a message's words, its decision note or its accepted answer. Those are not one `OR`, which no index
 * serves (#1019): each is its own query on its own index, and the three are merged under one order and
 * bound. The words use the trigram index `idx_messages_search_folded` on the same expression — which
 * is why a search is at least three characters (`SEARCH_QUERY_MIN`) — after a look at the newest
 * messages, which answers a common term without the index; the note and the answer use the partial
 * indexes `idx_messages_search_noted` and `idx_messages_search_answered`.
 */
import { notHiddenBy } from '../messages/hidden';
import {
  sql,
  type AliasableExpression,
  type Expression,
  type SelectQueryBuilder,
} from '@purlay/db';
import type { ChatDb, ChatSchema } from '../schema';
import {
  SEARCH_QUERY_MIN,
  type MessagePage,
  type SearchQuery,
  type SearchCriteria,
} from '@purlay/types';
import { AppError } from '../../../platform/errors';
import { channelNotFound, withinMessageHistory } from '../channels/guard';
import type { WorkspaceContext } from '../../../platform/tenancy';
import { MESSAGE_COLUMNS } from '../messages/reader';
import { asPage } from '../messages/threads';
import { limitOf } from '../../../platform/pagination';
import { literalPattern } from '../../../platform/like-pattern';

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

/** `messages` and the message each one replies to, which has no columns where it replies to none. */
type MessagesWithParent = SelectQueryBuilder<
  ChatSchema & {
    parent: { [Column in keyof ChatSchema['messages']]: ChatSchema['messages'][Column] | null };
  },
  'messages' | 'parent',
  object
>;

/**
 * How many of the newest messages a search looks through before it asks the trigram index. A term
 * that is common fills a page from them and never needs the index, whose answer for such a term is
 * most of the workspace; a term that is not finds its few matches in the index in a few
 * milliseconds. Which of the two a term is, the planner cannot know from the pattern.
 */
const NEWEST_LOOKED_THROUGH = 5000;

/**
 * The decision note and the accepted answer, each an expression of its own and not an `OR` with the
 * words, so that each is answered by its own index: the two small partial indexes of migration 0081,
 * which hold only the roots that have one. The `<> ''` and `is not null` are those indexes' own
 * predicates; a pattern of three letters or more never matches an empty note. The answer is a scalar
 * subquery, not an `EXISTS`: the planner flattens an `EXISTS` into a join and may start from the
 * answers, which for a common term are most of the workspace; this one is read from the question.
 */
const inNote = (pattern: string): Expression<boolean> =>
  sql<boolean>`(messages.decision_note <> '' and purlay_fold(messages.decision_note) like purlay_fold(${pattern}))`;

const inAcceptedAnswer = (pattern: string): Expression<boolean> =>
  sql<boolean>`(messages.accepted_answer_id is not null and (
    select purlay_fold(answer.content) like purlay_fold(${pattern})
    from messages as answer
    where answer.id = messages.accepted_answer_id
      and answer.parent_id = messages.id
      and answer.deleted_at is null))`;

/**
 * `channelIds` is every channel the caller can see in the workspace. `query.channelId` narrows the
 * search to one of them; a channel outside that set — another workspace's, or one the caller is not
 * in — is the same `CHANNEL_NOT_FOUND` as anywhere else, never an empty answer that confirms it.
 * `query.senderId` narrows it to one person's words (D-166), on `idx_messages_sender` or the trigram
 * index, whichever the planner finds the smaller.
 */
export const searchIn = async (
  executor: ChatDb,
  context: WorkspaceContext,
  visible: readonly string[],
  query: SearchQuery,
): Promise<MessagePage> => {
  validateSearch(query);
  if (query.channelId !== undefined && !visible.includes(query.channelId)) throw channelNotFound();
  const channelIds = query.channelId === undefined ? visible : [query.channelId];
  if (channelIds.length === 0) return { data: [], nextCursor: null };
  const limit = limitOf(query);

  // Every filter but the words, for each query below to add its own words, order and bound to.
  const filtered = (): MessagesWithParent => {
    let candidates = executor
      .selectFrom('messages')
      .leftJoin('messages as parent', 'parent.id', 'messages.parent_id')
      .where('messages.workspace_id', '=', context.workspaceId)
      .where('messages.channel_id', 'in', channelIds)
      .where(withinMessageHistory(executor, context))
      .where('messages.deleted_at', 'is', null)
      .where(notHiddenBy(context.userId));
    if (query.question === 'yes') candidates = candidates.where('messages.is_question', '=', true);
    if (query.status !== undefined) {
      candidates = candidates.where(
        sql`coalesce(parent.resolved_at, messages.resolved_at)`,
        query.status === 'resolved' ? 'is not' : 'is',
        null,
      );
      if (query.status === 'open')
        candidates = candidates.where(sql<boolean>`
        (coalesce(parent.is_question, messages.is_question) OR coalesce(parent.thread_reply_count, messages.thread_reply_count) > 0)
      `);
    }
    if (query.since !== undefined)
      candidates = candidates.where('messages.created_at', '>=', new Date(query.since));
    if (query.until !== undefined)
      candidates = candidates.where('messages.created_at', '<', new Date(query.until));
    if (query.kind === 'code')
      candidates = candidates.where(
        sql<boolean>`jsonb_array_length(coalesce(messages.metadata->'codeLanguages', '[]'::jsonb)) > 0`,
      );
    if (query.kind === 'file')
      candidates = candidates.where((eb) =>
        eb.exists(
          eb
            .selectFrom('message_attachments')
            .select('message_attachments.attachment_id')
            .whereRef('message_attachments.message_id', '=', 'messages.id'),
        ),
      );
    if (query.repository !== undefined) {
      const repository = query.repository.toLowerCase();
      candidates = candidates.where(sql<boolean>`
        (lower(messages.metadata->>'repository') = ${repository}
        OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(coalesce(messages.metadata->'githubLinks', '[]'::jsonb)) AS link(value)
          WHERE lower(split_part(link.value, '/', 4) || '/' || split_part(link.value, '/', 5)) = ${repository})
        OR (split_part(messages.decision_url, '/', 3) = 'github.com' AND
          lower(split_part(messages.decision_url, '/', 4) || '/' || split_part(messages.decision_url, '/', 5)) = ${repository}))
      `);
    }
    if (query.before !== undefined) candidates = candidates.where('messages.id', '<', query.before);
    // Who wrote it narrows the visible set further and never widens it (D-166): an author's words in a
    // channel the caller cannot see stay unseen, and a person of another workspace finds nothing here.
    if (query.senderId !== undefined) {
      candidates = candidates.where('messages.sender_id', '=', query.senderId);
    }
    return candidates;
  };

  if (query.q === '') {
    const rows = await filtered()
      .leftJoin('users', 'users.id', 'messages.sender_id')
      .select(MESSAGE_COLUMNS)
      .orderBy('messages.id', 'desc')
      .limit(limit + 1)
      .execute();
    return await asPage(executor, rows, limit);
  }

  const pattern = literalPattern(query.q);
  const pageSize = limit + 1;
  // One query of its own, with its own order and bound, so that it stays its own inside the union.
  const newestMatching = (words: Expression<boolean>): AliasableExpression<{ id: string }> =>
    filtered()
      .select('messages.id')
      .where(words)
      .orderBy('messages.id', 'desc')
      .limit(pageSize)
      .$castTo<{ id: string }>();

  // The newest messages are looked through first, a page of their matches taken in order. Only when
  // those do not fill a page does the index look further back — before the oldest of them, so no
  // message is read twice — and the note and the answer are asked in any case: they are small.
  const rows = await executor
    .with('newest', () =>
      filtered()
        .select(['messages.id', 'messages.content'])
        .orderBy('messages.id', 'desc')
        .limit(NEWEST_LOOKED_THROUGH),
    )
    .with('newest_matching', (qb) =>
      qb
        .selectFrom('newest')
        .select('newest.id')
        .where(sql<boolean>`purlay_fold(newest.content) like purlay_fold(${pattern})`)
        .orderBy('newest.id', 'desc')
        .limit(pageSize),
    )
    .selectFrom('messages')
    .leftJoin('users', 'users.id', 'messages.sender_id')
    .select(MESSAGE_COLUMNS)
    .where('messages.id', 'in', (eb) =>
      eb
        .selectFrom('newest_matching')
        .select('newest_matching.id')
        .union(
          executor
            .selectFrom(
              newestMatching(
                sql<boolean>`messages.id < (select id from newest order by id limit 1)
                  and (select count(*) from newest_matching) < ${pageSize}
                  and purlay_fold(messages.content) like purlay_fold(${pattern})`,
              ).as('older'),
            )
            .select('older.id'),
        )
        .union(executor.selectFrom(newestMatching(inNote(pattern)).as('noted')).select('noted.id'))
        .union(
          executor
            .selectFrom(newestMatching(inAcceptedAnswer(pattern)).as('answered'))
            .select('answered.id'),
        ),
    )
    .orderBy('messages.id', 'desc')
    .limit(pageSize)
    .execute();

  return await asPage(executor, rows, limit);
};
