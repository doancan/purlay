/** __PASCAL__ through HTTP: the list and the create. Nothing here tells a socket. */
import { Create__PASCAL__ItemRequest, type __PASCAL__Item } from '@purlay/types';
import { requireLiveSession } from '../../../modules/auth/sessions';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import type { __PASCAL__Db } from '../schema';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';
import { create__PASCAL__Item, list__PASCAL__Items } from '../items';

// Who may ask is settled first, by the core's read of the membership, outside the module's share of the database:
// a person who is not in the workspace must not be able to hold its slots.

/** `GET /api/workspaces/:workspaceId/__ID__` — newest first. */
export const list__PASCAL__ = async (
  { auth, database }: ModuleRouteDependencies<__PASCAL__Db>,
  request: Request,
  workspaceId: string,
): Promise<readonly __PASCAL__Item[]> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await list__PASCAL__Items(database, context);
};

/** `POST /api/workspaces/:workspaceId/__ID__` — `201` with the row. */
export const post__PASCAL__ = async (
  { auth, database, clock }: ModuleRouteDependencies<__PASCAL__Db>,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<__PASCAL__Item> => {
  const { userId, sessionId } = await requireSession(auth, request);
  const input = validated(Create__PASCAL__ItemRequest, body);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await atomicallyOn(database)(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    return await create__PASCAL__Item(transaction, clock, context, input);
  });
};
