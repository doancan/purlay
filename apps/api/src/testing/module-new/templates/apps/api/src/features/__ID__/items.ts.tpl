/**
 * __PASCAL__'s rows: a list and a create. Every query is scoped to the caller's `WorkspaceContext`, so a row of another
 * workspace is as absent as one that never was (D-21).
 */
import { messageId as newId, type Create__PASCAL__ItemRequest, type __PASCAL__Item } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { WorkspaceContext } from '../../platform/tenancy';
import type { __PASCAL__Db, __PASCAL__Tx } from './schema';

/** One page of a list: a page is the longest a response should be. */
export const __UPPER___PAGE = 100;

export const list__PASCAL__Items = async (
  database: __PASCAL__Db,
  context: WorkspaceContext,
): Promise<readonly __PASCAL__Item[]> =>
  (
    await database
      .selectFrom('__SNAKE__')
      .select(['id', 'title', 'created_at'])
      .where('workspace_id', '=', context.workspaceId)
      .orderBy('id', 'desc')
      .limit(__UPPER___PAGE)
      .execute()
  ).map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at.toISOString() }));

export const create__PASCAL__Item = async (
  transaction: __PASCAL__Tx,
  clock: Clock,
  context: WorkspaceContext,
  input: Create__PASCAL__ItemRequest,
): Promise<__PASCAL__Item> => {
  const row = await transaction
    .insertInto('__SNAKE__')
    .values({ id: newId(clock.now()), workspace_id: context.workspaceId, title: input.title.trim() })
    .returning(['id', 'title', 'created_at'])
    .executeTakeFirstOrThrow();
  return { id: row.id, title: row.title, createdAt: row.created_at.toISOString() };
};
