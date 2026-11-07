/**
 * `GET /api/workspaces/:workspaceId/find` (D-283 §4, D-285) — the words, asked of every search source of every module that
 * runs and answered as a group for each. The core's, so it answers with chat not run and finds the issues: who may ask is
 * the workspace's membership, read by the core outside any module's share, and what each source may show is its own query's.
 * `q` is trimmed before it is measured, as search's is: three spaces and a letter are not a search.
 */
import { FIND_HITS_MAX, FindQuery, type FindResponse } from '@purlay/types';
import type { Executor } from '@purlay/db';
import { findAcross, type FindDependencies } from '../../modules/find/find';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import type { Auth } from '../../modules/auth/better-auth';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

export interface FindRouteDependencies extends FindDependencies {
  readonly auth: Auth;
  readonly database: Executor;
}

export const readFind = async (
  dependencies: FindRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<FindResponse> => {
  const { userId } = await requireSession(dependencies.auth, request);
  const query = queryOf(new URL(request.url), { numbers: ['limit'] });
  if (typeof query['q'] === 'string') query['q'] = query['q'].trim();
  const { q, limit = FIND_HITS_MAX } = validated(FindQuery, query);
  const context = await requireWorkspaceMembership(dependencies.database, userId, workspaceId);
  return await findAcross(dependencies, context, q, limit);
};
