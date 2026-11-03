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
import { createIssue, deleteIssue, issuePage, updateIssue } from '../../features/issues/issues';
import { requireLiveSession } from '../../modules/auth/sessions';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import type { Atomically } from '../../platform/transactions';
import type { ChannelDependencies } from './channels';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

/**
 * What these routes need beyond a channel's: the transaction boundary of the issues module's share of the
 * database (`features/issues/budget.ts`). Every statement they run, a read as much as a write, goes through it,
 * so a module of many slow requests holds a third of the pool at most and chat's sends are never queued behind it.
 */
export interface IssueDependencies extends ChannelDependencies {
  readonly atomically: Atomically;
}

/** `GET /api/workspaces/:workspaceId/issues?status=&before=&limit=` — newest first. */
export const listIssues = async (
  { auth, atomically }: IssueDependencies,
  request: Request,
  workspaceId: string,
): Promise<IssuePage> => {
  const { userId } = await requireSession(auth, request);
  const query = validated(IssueQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await atomically(async (transaction) => {
    const context = await requireWorkspaceMembership(transaction, userId, workspaceId);
    return await issuePage(transaction, context, query);
  });
};

/** `POST /api/workspaces/:workspaceId/issues` — `201` with the issue, open. */
export const postIssue = async (
  { auth, atomically, clock }: IssueDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<Issue> => {
  const { userId, sessionId } = await requireSession(auth, request);
  const input = validated(CreateIssueRequest, body);
  return await atomically(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    const context = await requireWorkspaceMembership(transaction, userId, workspaceId);
    return await createIssue(transaction, clock, context, input);
  });
};

/** `PATCH /api/workspaces/:workspaceId/issues/:issueId` — the issue as it is now. */
export const patchIssue = async (
  { auth, atomically, clock }: IssueDependencies,
  request: Request,
  workspaceId: string,
  issueId: string,
  body: unknown,
): Promise<Issue> => {
  const { userId, sessionId } = await requireSession(auth, request);
  const input = validated(UpdateIssueRequest, body);
  return await atomically(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    const context = await requireWorkspaceMembership(transaction, userId, workspaceId);
    return await updateIssue(transaction, clock, context, issueId, input);
  });
};

/** `DELETE /api/workspaces/:workspaceId/issues/:issueId` — `204`; for its creator, or an owner or an admin. */
export const removeIssue = async (
  { auth, atomically, clock }: IssueDependencies,
  request: Request,
  workspaceId: string,
  issueId: string,
): Promise<void> => {
  const { userId, sessionId } = await requireSession(auth, request);
  await atomically(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    const context = await requireWorkspaceMembership(transaction, userId, workspaceId);
    await deleteIssue(transaction, clock, context, issueId);
  });
};
