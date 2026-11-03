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
import { atomicallyOn } from '../../platform/transactions';
import type { ChannelDependencies } from './channels';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

/** `GET /api/workspaces/:workspaceId/issues?status=&before=&limit=` — newest first. */
export const listIssues = async (
  { auth, database }: ChannelDependencies,
  request: Request,
  workspaceId: string,
): Promise<IssuePage> => {
  const { userId } = await requireSession(auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const query = validated(IssueQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await issuePage(database, context, query);
};

/** `POST /api/workspaces/:workspaceId/issues` — `201` with the issue, open. */
export const postIssue = async (
  { auth, database, clock }: ChannelDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<Issue> => {
  const { userId, sessionId } = await requireSession(auth, request);
  const input = validated(CreateIssueRequest, body);
  return await atomicallyOn(database)(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    const context = await requireWorkspaceMembership(transaction, userId, workspaceId);
    return await createIssue(transaction, clock, context, input);
  });
};

/** `PATCH /api/workspaces/:workspaceId/issues/:issueId` — the issue as it is now. */
export const patchIssue = async (
  { auth, database, clock }: ChannelDependencies,
  request: Request,
  workspaceId: string,
  issueId: string,
  body: unknown,
): Promise<Issue> => {
  const { userId, sessionId } = await requireSession(auth, request);
  const input = validated(UpdateIssueRequest, body);
  return await atomicallyOn(database)(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    const context = await requireWorkspaceMembership(transaction, userId, workspaceId);
    return await updateIssue(transaction, clock, context, issueId, input);
  });
};

/** `DELETE /api/workspaces/:workspaceId/issues/:issueId` — `204`; for its creator, or an owner or an admin. */
export const removeIssue = async (
  { auth, database, clock }: ChannelDependencies,
  request: Request,
  workspaceId: string,
  issueId: string,
): Promise<void> => {
  const { userId, sessionId } = await requireSession(auth, request);
  await atomicallyOn(database)(async (transaction) => {
    await requireLiveSession(transaction, clock, sessionId);
    const context = await requireWorkspaceMembership(transaction, userId, workspaceId);
    await deleteIssue(transaction, context, issueId);
  });
};
