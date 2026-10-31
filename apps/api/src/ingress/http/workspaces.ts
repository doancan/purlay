/**
 * The workspace endpoints Phase 0 serves (`API.md` §3).
 *
 * Framework-neutral, like the sign-in handlers: a request in, a decision out.
 * The routing lives in `app.ts`.
 *
 * **Every handler that names a workspace goes through the membership guard**,
 * which is the only producer of a `WorkspaceContext` — so a repository call that
 * forgot to scope itself would not compile, and a caller outside the workspace
 * gets `404`, never `403` (D-21).
 */
import type { Auth } from '../../modules/auth/better-auth';
import type { Executor } from '@purlay/db';
import {
  AuditExportQuery,
  AuditQuery,
  CreateWorkspaceRequest,
  SetGitHubTokenRequest,
  type GitHubIntegration,
  SetDeepWorkRequest,
  type AuditPage,
  UpdateMemberRoleRequest,
  UpdateWorkspaceRequest,
  type DeepWorkResponse,
  type MeResponse,
  type Membership,
  type Workspace,
  type WorkspaceMember,
  type RetentionSetting,
  type StorageUsage,
  SetRetentionRequest,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import {
  createWorkspace,
  meOf,
  membersIn,
  membershipsOf,
  renameWorkspace,
  workspaceIn,
} from '../../modules/workspaces/workspaces';
import { setDeepWork } from '../../modules/workspaces/deep-work';
import {
  requireMayCreateWorkspace,
  type WorkspaceCreators,
} from '../../modules/workspaces/creators';
import { changeRole, leaveWorkspace, removeMember } from '../../modules/workspaces/members';
import { auditTrail } from '../../modules/audit/audit';
import { exportTrail } from '../../modules/audit/audit-export';
import { readRetention, setRetention } from '../../modules/workspaces/retention';
import { readStorage } from '../../modules/attachments/quota';
import {
  githubIntegrationOf,
  removeGitHubToken,
  setGitHubToken,
} from '../../modules/integrations/github';
import type { CredentialCipher } from '../../platform/crypto';
import {
  NO_LOG,
  publication,
  publishAccessRevoked,
  publishDeepWorkUpdated,
  publishAfterCommit,
  publishWorkspaceUpdated,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { requireSession } from './session';
import { queryOf, validated } from './validate';

export interface WorkspaceDependencies {
  /** Who is calling: every session is resolved through it (`sessions.ts`, D-179). */
  readonly auth: Auth;
  readonly database: Executor;
  readonly clock: Clock;
}

/** What answers whether the caller may make a workspace (D-155): the server's setting (D-179 §6). */
export interface CreatorDependencies extends WorkspaceDependencies {
  /** Who may, as read through this executor: inside the transaction that makes the workspace. */
  readonly workspaceCreators: (executor: Executor) => Promise<WorkspaceCreators>;
}

/**
 * `GET /api/me` — who the caller is, and what they belong to.
 *
 * The only shape that carries an email address, and only ever to its owner
 * (`models.ts`). The client cannot render anything until it knows this, which is
 * why it is Phase 0 and why nothing else can stand in for it.
 */
export const readMe = async (
  dependencies: CreatorDependencies,
  request: Request,
): Promise<MeResponse> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  return await meOf(database, clock, userId, await dependencies.workspaceCreators(database));
};

export const listMyWorkspaces = async (
  dependencies: WorkspaceDependencies,
  request: Request,
): Promise<readonly Membership[]> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  return await membershipsOf(database, clock, userId);
};

export const createMyWorkspace = async (
  dependencies: CreatorDependencies,
  request: Request,
  body: unknown,
): Promise<Workspace> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const input = validated(CreateWorkspaceRequest, body);
  return await atomicallyOn(database)(async (transaction) => {
    await requireMayCreateWorkspace(
      transaction,
      await dependencies.workspaceCreators(transaction),
      userId,
    );
    return await createWorkspace(transaction, clock, userId, input);
  });
};

export const readWorkspace = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<Workspace> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await workspaceIn(database, context);
};

export const listWorkspaceMembers = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<readonly WorkspaceMember[]> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await membersIn(database, context);
};

/**
 * `PUT /api/workspaces/:workspaceId/deep-work` — the caller's own Deep Work here (D-108): started
 * until an instant, or ended. A workspace they are not in is the stranger's `404`.
 */
export const setMyDeepWork = async (
  dependencies: MemberWriteDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<DeepWorkResponse> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const input = validated(SetDeepWorkRequest, body);
  const answer = await setDeepWork(database, clock, context, input);
  // The person's other tabs draw it too (#526).
  await publishAfterCommit(log, [
    [
      publication('DEEP_WORK_UPDATED', () =>
        publishDeepWorkUpdated(bus, clock, userId, workspaceId, answer.until),
      ),
    ],
  ]);
  return answer;
};

export interface MemberWriteDependencies extends WorkspaceDependencies {
  readonly bus: EventBus;
  readonly log?: Logger;
}

/**
 * `PATCH /api/workspaces/:workspaceId` — a new name (D-124). Its members' sockets are told after the
 * commit, so every tab of theirs reads it again.
 */
export const updateWorkspace = async (
  dependencies: MemberWriteDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<Workspace> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const { name } = validated(UpdateWorkspaceRequest, body);
  const { workspace, memberIds } = await atomicallyOn(database)(
    async (transaction) => await renameWorkspace(transaction, clock, context, name),
  );
  await publishAfterCommit(log, [
    [
      publication('WORKSPACE_UPDATED', () =>
        publishWorkspaceUpdated(bus, clock, memberIds, workspace.id),
      ),
    ],
  ]);
  return workspace;
};

/** `PATCH /api/workspaces/:workspaceId/members/:userId` — a member's new role (§7.4, I-2). */
export const updateMemberRole = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
  userId: string,
  body: unknown,
): Promise<WorkspaceMember> => {
  const { database, clock } = dependencies;
  const caller = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, caller.userId, workspaceId);
  const { role } = validated(UpdateMemberRoleRequest, body);
  return await atomicallyOn(database)(
    async (transaction) => await changeRole(transaction, clock, context, userId, role),
  );
};

/**
 * `DELETE /api/workspaces/:workspaceId/members/:userId` — out of the workspace and its channels;
 * their sockets are told after the commit, and stop receiving every channel they could see (D-85).
 */
export const removeWorkspaceMember = async (
  dependencies: MemberWriteDependencies,
  request: Request,
  workspaceId: string,
  userId: string,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const caller = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, caller.userId, workspaceId);
  const { channelIds } = await atomicallyOn(database)(
    async (transaction) => await removeMember(transaction, clock, context, userId),
  );
  await publishAfterCommit(log, [
    [publication('ACCESS_REVOKED', () => publishAccessRevoked(bus, clock, userId, channelIds))],
  ]);
};

/**
 * `DELETE /api/workspaces/:workspaceId/membership` — the caller leaves the workspace and its channels
 * (D-152). Anybody's; the last owner is `409 LAST_OWNER`. Their own sockets are told, as a removed
 * member's are.
 */
export const leaveWorkspaceMembership = async (
  dependencies: MemberWriteDependencies,
  request: Request,
  workspaceId: string,
): Promise<void> => {
  const { database, clock, bus, log = NO_LOG } = dependencies;
  const caller = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, caller.userId, workspaceId);
  const { channelIds } = await atomicallyOn(database)(
    async (transaction) => await leaveWorkspace(transaction, clock, context),
  );
  await publishAfterCommit(log, [
    [
      publication('ACCESS_REVOKED', () =>
        publishAccessRevoked(bus, clock, caller.userId, channelIds),
      ),
    ],
  ]);
};

/** `GET /api/workspaces/:workspaceId/audit` — the trail, newest first, narrowed (D-26, #70, D-222). */
export const readAuditTrail = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<AuditPage> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const query = validated(AuditQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await auditTrail(database, context, query);
};

/**
 * `GET /api/workspaces/:workspaceId/audit/export` — the narrowed trail as a CSV or NDJSON file, streamed
 * (D-222). An attachment the browser saves, never a page it renders.
 */
export const exportAuditTrail = async (
  dependencies: WorkspaceDependencies & { readonly log: Logger },
  request: Request,
  workspaceId: string,
): Promise<{
  readonly body: ReadableStream<Uint8Array>;
  readonly headers: Record<string, string>;
}> => {
  const { database, clock, log } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const query = validated(AuditExportQuery, queryOf(new URL(request.url)));
  const download = await exportTrail(database, clock, log, context, query);
  return {
    body: download.body,
    headers: {
      'content-type': download.contentType,
      'content-disposition': `attachment; filename="${download.filename}"`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  };
};

/** `GET /api/workspaces/:workspaceId/retention` — how long the history is kept; an owner's (D-139 §4). */
export const readRetentionSetting = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<RetentionSetting> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await readRetention(database, context);
};

/**
 * `GET /api/workspaces/:workspaceId/storage` — how much of its quota the workspace's files take; an
 * owner's (D-173).
 */
export const readStorageUsage = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<StorageUsage> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await readStorage(database, context);
};

/**
 * `PUT /api/workspaces/:workspaceId/retention` — an owner sets how long the history is kept (D-139 §4).
 * Nothing is told to anyone's socket: the window changes nothing on a screen until the night's purge,
 * and the purge itself tells nobody (§3).
 */
export const updateRetentionSetting = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<RetentionSetting> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const { retentionDays } = validated(SetRetentionRequest, body);
  return await atomicallyOn(database)(
    async (transaction) => await setRetention(transaction, clock, context, retentionDays),
  );
};

/** `GET /api/workspaces/:workspaceId/integrations/github` — whether a token is set. Never the token. */
export const readGitHubIntegration = async (
  dependencies: WorkspaceDependencies,
  request: Request,
  workspaceId: string,
): Promise<GitHubIntegration> => {
  const { database } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await githubIntegrationOf(database, context);
};

/** `PUT` sets the workspace's token, sealed; `DELETE` removes it (D-11, D-39 §6). */
export const changeGitHubToken = async (
  dependencies: WorkspaceDependencies & { readonly cipher: CredentialCipher },
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<void> => {
  const { database, clock, cipher } = dependencies;
  const { userId } = await requireSession(dependencies.auth, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  if (request.method === 'DELETE') {
    await atomicallyOn(database)(async (transaction) => {
      await removeGitHubToken(transaction, clock, context);
    });
    return;
  }
  const { token } = validated(SetGitHubTokenRequest, body);
  await atomicallyOn(database)(async (transaction) => {
    await setGitHubToken(transaction, clock, cipher, context, token);
  });
};
