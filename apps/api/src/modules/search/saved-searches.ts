import { Value } from '@sinclair/typebox/value';
import { sql, type Executor } from '@purlay/db';
import {
  SAVED_SEARCH_LIMIT,
  SearchCriteria,
  Uuid,
  type PageQuery,
  type SavedSearch,
  type SavedSearchPage,
  type SaveSearchRequest,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { WorkspaceContext } from '../../platform/tenancy';
import { channelNotFound, visibleChannelIds } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import { limitOf } from '../messages/threads';
import { validateSearch } from './search';

const missing = (): AppError =>
  new AppError({ code: 'SAVED_SEARCH_NOT_FOUND', message: 'Saved search not found.' });

const asSearch = (row: {
  id: string;
  name: string;
  query: unknown;
  created_at: Date | string;
}): SavedSearch => {
  if (!Value.Check(SearchCriteria, row.query))
    throw new Error('stored search violates its contract');
  return {
    id: row.id,
    name: row.name,
    query: row.query,
    createdAt: new Date(row.created_at).toISOString(),
  };
};

export const listSearches = async (
  db: Executor,
  context: WorkspaceContext,
  page: PageQuery,
): Promise<SavedSearchPage> => {
  const limit = limitOf(page);
  let query = db
    .selectFrom('saved_searches')
    .selectAll()
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .orderBy('id', 'desc')
    .limit(limit + 1);
  if (page.before !== undefined) query = query.where('id', '<', page.before);
  const rows = await query.execute();
  const data = rows.slice(0, limit).map(asSearch);
  return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
};

/** Called inside the HTTP transaction. The membership lock serializes saves at the personal cap. */
export const saveSearch = async (
  db: Executor,
  clock: Clock,
  context: WorkspaceContext,
  id: string,
  input: SaveSearchRequest,
): Promise<SavedSearch> => {
  if (!Value.Check(Uuid, id)) throw missing();
  validateSearch(input.query);
  const name = input.name.trim();
  if (name === '')
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Name the saved search.',
      details: { fields: { name: 'Required.' } },
    });
  if (
    input.query.channelId !== undefined &&
    !(await visibleChannelIds(db, context)).includes(input.query.channelId)
  )
    throw channelNotFound();
  const member = await db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .forUpdate()
    .executeTakeFirst();
  if (member === undefined) throw missing();
  const existing = await db
    .selectFrom('saved_searches')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirst();
  if (
    existing !== undefined &&
    (existing.user_id !== context.userId || existing.workspace_id !== context.workspaceId)
  )
    throw missing();
  if (existing === undefined) {
    const count = await db
      .selectFrom('saved_searches')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('workspace_id', '=', context.workspaceId)
      .where('user_id', '=', context.userId)
      .executeTakeFirstOrThrow();
    if (count.count >= SAVED_SEARCH_LIMIT)
      throw new AppError({
        code: 'SAVED_SEARCH_LIMIT',
        message: 'Remove a saved search before adding another.',
      });
  }
  const row = await db
    .insertInto('saved_searches')
    .values({
      id,
      workspace_id: context.workspaceId,
      user_id: context.userId,
      name,
      query: JSON.stringify(input.query),
      created_at: clock.now(),
    })
    .onConflict((conflict) =>
      conflict
        .column('id')
        .doUpdateSet({ name, query: JSON.stringify(input.query) })
        .where('saved_searches.user_id', '=', context.userId)
        .where('saved_searches.workspace_id', '=', context.workspaceId),
    )
    .returningAll()
    .executeTakeFirst();
  if (row === undefined) throw missing();
  return asSearch(row);
};

export const removeSearch = async (
  db: Executor,
  context: WorkspaceContext,
  id: string,
): Promise<void> => {
  if (!Value.Check(Uuid, id)) throw missing();
  await db
    .deleteFrom('saved_searches')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', '=', context.userId)
    .where('id', '=', id)
    .execute();
};
