/**
 * A workspace's issues through HTTP (D-254): the list, make, change and delete. Nothing here tells a socket: an
 * issue has no frame, and a client reads again (`MODULES.md` §11).
 */
import {
  CreateIssueRequest,
  IssueQuery,
  UpdateIssueRequest,
  type Issue,
  type IssuePage,
} from '@purlay/types';
import { requireLiveSession } from '../../../modules/auth/sessions';
import { requireWorkspaceMembership } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import { requireSession } from '../../../ingress/http/session';
import { queryOf, validated } from '../../../ingress/http/validate';
import { createIssue, deleteIssue, issuePage, updateIssue } from '../issues';

// Every statement these routes run is held to the issues module's share of the database by the database they are
// handed (`../budget.ts`, `platform/module-budget.ts`). Who may ask is settled first, by the core's read of
// the membership, outside the share: a person who is not in the workspace must not be able to hold its slots.

/** `GET /api/workspaces/:workspaceId/issues?status=&before=&limit=` — newest first. */
export const listIssues = async (
  { auth, database }: ModuleRouteDependencies,
  request: Request,
  workspaceId: string,
): Promise<IssuePage> => {
  const { userId } = await requireSession(auth, request);
  const query = validated(IssueQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await atomicallyOn(database)(
    async (transaction) => await issuePage(transaction, context, query),
  );
};

/** `POST /api/workspaces/:workspaceId/issues` — `201` with the issue, open. */
export const postIssue = async (
  { auth, database, clock, inbox }: ModuleRouteDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<Issue> => {
  const { userId, sessionId } = await requireSession(auth, request);
  const input = validated(CreateIssueRequest, body);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const { issue, told } = await atomicallyOn(database)(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    return await createIssue(transaction, clock, context, input, inbox);
  });
  await inbox.announce(told);
  return issue;
};

/** `PATCH /api/workspaces/:workspaceId/issues/:issueId` — the issue as it is now. */
export const patchIssue = async (
  { auth, database, clock, inbox }: ModuleRouteDependencies,
  request: Request,
  workspaceId: string,
  issueId: string,
  body: unknown,
): Promise<Issue> => {
  const { userId, sessionId } = await requireSession(auth, request);
  const input = validated(UpdateIssueRequest, body);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const { issue, told } = await atomicallyOn(database)(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    return await updateIssue(transaction, clock, context, issueId, input, inbox);
  });
  await inbox.announce(told);
  return issue;
};

/** `DELETE /api/workspaces/:workspaceId/issues/:issueId` — `204`; for its creator, or an owner or an admin. */
export const removeIssue = async (
  { auth, database, clock, permissions }: ModuleRouteDependencies,
  request: Request,
  workspaceId: string,
  issueId: string,
): Promise<void> => {
  const { userId, sessionId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  await atomicallyOn(database)(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    await deleteIssue(transaction, clock, context, permissions, issueId);
  });
};
