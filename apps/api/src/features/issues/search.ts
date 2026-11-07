/**
 * Issues' source of the workspace-wide find (D-285): a workspace's issues whose title or body hold the words, ignoring case,
 * newest first. Any member may read any issue (D-254), so the workspace is the only narrowing, and it is in each query.
 *
 * The title and the body are two queries, each on its own trigram index (`issues/0002_issues_search.sql`) and not one `OR`,
 * which no index serves (chat's search learned that, #1019); their answers are merged under one order and cut to the limit.
 * Both compare `purlay_fold` of the column with the folded words, as chat does, so I, ı, İ and i are one letter (#700).
 */
import type { FindHit } from '@purlay/types';
import { literalPattern } from '../../platform/like-pattern';
import { oneLine } from '../../platform/one-line';
import type { SearchSource } from '../../platform/ports/search-source';
import type { IssuesDb } from './schema';

const LINE_MAX = 200;

const SEARCH_COLUMNS = ['id', 'title', 'body', 'created_at'] as const;

type Column = 'title' | 'body';

const matching = async (
  database: IssuesDb,
  workspaceId: string,
  column: Column,
  pattern: string,
  limit: number,
): Promise<readonly IssueMatch[]> =>
  await database
    .selectFrom('issues')
    .select(SEARCH_COLUMNS)
    .where('workspace_id', '=', workspaceId)
    .where((eb) =>
      eb(
        eb.fn<string>('purlay_fold', [column]),
        'like',
        eb.fn<string>('purlay_fold', [eb.val(pattern)]),
      ),
    )
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();

interface IssueMatch {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly created_at: Date;
}

const toHit = (row: IssueMatch): FindHit => ({
  id: row.id,
  title: oneLine(row.title, LINE_MAX),
  excerpt: row.body === '' ? null : oneLine(row.body, LINE_MAX),
  at: row.created_at.toISOString(),
  target: { type: 'issue', issueId: row.id },
});

export const issuesSearchSource: SearchSource = {
  id: 'issues',
  search: async ({ database, context, query, limit }) => {
    const pattern = literalPattern(query);
    const found = await Promise.all(
      (['title', 'body'] as const).map(
        async (column) => await matching(database, context.workspaceId, column, pattern, limit),
      ),
    );
    const byId = new Map(found.flat().map((row) => [row.id, row]));
    return [...byId.values()]
      .sort((a, b) => (a.id < b.id ? 1 : -1))
      .slice(0, limit)
      .map(toHit);
  },
};
