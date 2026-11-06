/** Guard first, then strict parsing. Global metadata does not mint a workspace membership. */
import { readBackupEvidence } from '../../platform/backup-evidence';
import type { ServerBackupStatus } from '@purlay/types';
import {
  ServerPreferencesRequest,
  ServerAdmissionRequest,
  type ServerPreferences,
  type OwnAdmission,
} from '@purlay/types';
import {
  changeServerPreferences,
  readServerPreferences,
  decideAdmission,
  admissionStateOf,
} from '../../modules/administration/admission';
import { sessionFromHeaders } from '../../modules/auth/sessions';
import {
  ServerAdminRequest,
  ServerAuditQuery,
  ServerQuotaRequest,
  ServerUsersQuery,
  ServerWorkspacesQuery,
  ServerEmptyRequest,
  ServerMembershipsQuery,
  Uuid,
  type ServerAuditPage,
  type ServerUserPage,
  type ServerUserDetail,
  type ServerWorkspacePage,
  type ServerOperations,
  type ServerOverview,
  type ServerMailStatus,
} from '@purlay/types';
import { requireServerAdmin } from '../../modules/setup/setup';
import {
  listServerAudit,
  listServerUsers,
  listServerWorkspaces,
  serverUserDetail,
} from '../../modules/administration/inventory';
import {
  changeServerAdministrator,
  changeServerQuota,
  revokeServerUserSessions,
} from '../../modules/administration/changes';
import {
  serverMailStatus,
  serverOperations,
  serverOverview,
} from '../../modules/administration/status';
import { atomicallyOn } from '../../platform/transactions';
import { publication, publishAfterCommit, publishSessionsEnded } from '../../platform/events';
import type { Readiness } from '../../platform/readiness';
import type { AccountDependencies } from './accounts';
import type { Config } from '../../platform/config';
import { queryOf, validated } from './validate';

export interface AdministrationDependencies extends AccountDependencies {
  readonly config: Config;
  readonly modules: readonly string[];
  readonly jobs: readonly string[];
  readonly readiness: () => Promise<Readiness>;
}
const guard = async (
  deps: AccountDependencies,
  request: Request,
): ReturnType<typeof requireServerAdmin> =>
  await requireServerAdmin(deps.auth, deps.database, request.headers);

export const readAdministrationUsers = async (
  deps: AccountDependencies,
  request: Request,
): Promise<ServerUserPage> => {
  const admin = await guard(deps, request);
  const query = validated(ServerUsersQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await listServerUsers(deps.database, admin, query);
};
export const readAdministrationUser = async (
  deps: AccountDependencies,
  request: Request,
  userId: string,
): Promise<ServerUserDetail> => {
  const admin = await guard(deps, request);
  const query = validated(ServerMembershipsQuery, queryOf(new URL(request.url)));
  return await serverUserDetail(
    deps.database,
    admin,
    validated(Uuid, userId),
    query.after,
    deps.clock.now(),
    deps.auth.sessionLifetime,
  );
};
export const readAdministrationWorkspaces = async (
  deps: AccountDependencies,
  request: Request,
): Promise<ServerWorkspacePage> => {
  const admin = await guard(deps, request);
  const query = validated(
    ServerWorkspacesQuery,
    queryOf(new URL(request.url), { numbers: ['limit'] }),
  );
  return await listServerWorkspaces(deps.database, admin, query);
};
export const readAdministrationAudit = async (
  deps: AccountDependencies,
  request: Request,
): Promise<ServerAuditPage> => {
  const admin = await guard(deps, request);
  const query = validated(ServerAuditQuery, queryOf(new URL(request.url), { numbers: ['limit'] }));
  return await listServerAudit(deps.database, admin, query);
};
export const readAdministrationOperations = async (
  deps: AdministrationDependencies,
  request: Request,
): Promise<ServerOperations> => {
  const admin = await guard(deps, request);
  return await serverOperations(deps.database, admin, deps.jobs, deps.clock.now());
};
export const readAdministrationOverview = async (
  deps: AdministrationDependencies,
  request: Request,
): Promise<ServerOverview> => {
  const admin = await guard(deps, request);
  const ready = await deps.readiness();
  return await serverOverview(
    deps.database,
    admin,
    deps.config,
    deps.modules,
    ready.ready,
    deps.clock.now(),
  );
};
export const writeAdministrationRole = async (
  deps: AccountDependencies,
  request: Request,
  userId: string,
  body: unknown,
): Promise<void> => {
  const admin = await guard(deps, request);
  const id = validated(Uuid, userId);
  const input = validated(ServerAdminRequest, body);
  await atomicallyOn(deps.database)(async (tx) => {
    await changeServerAdministrator(tx, deps.clock, admin, id, input.isServerAdmin);
  });
};
export const writeAdministrationQuota = async (
  deps: AccountDependencies,
  request: Request,
  workspaceId: string,
  body: unknown,
): Promise<void> => {
  const admin = await guard(deps, request);
  const id = validated(Uuid, workspaceId);
  const input = validated(ServerQuotaRequest, body);
  await atomicallyOn(deps.database)(async (tx) => {
    await changeServerQuota(tx, deps.clock, admin, id, input.quotaBytes);
  });
};
export const writeAdministrationSessions = async (
  deps: AccountDependencies,
  request: Request,
  userId: string,
  body: unknown,
): Promise<void> => {
  const admin = await guard(deps, request);
  const id = validated(Uuid, userId);
  validated(ServerEmptyRequest, body);
  const ended = await atomicallyOn(deps.database)(
    async (tx) => await revokeServerUserSessions(tx, deps.clock, admin, id),
  );
  await publishAfterCommit(deps.log, [
    [publication('SESSION_ENDED', () => publishSessionsEnded(deps.bus, deps.clock, ended))],
  ]);
};

export const readAdministrationMail = async (
  deps: AccountDependencies,
  request: Request,
): Promise<ServerMailStatus> => {
  const admin = await guard(deps, request);
  return await serverMailStatus(admin, deps.database);
};

export const readAdministrationPreferences = async (
  deps: AccountDependencies,
  request: Request,
): Promise<ServerPreferences> => {
  await guard(deps, request);
  return await readServerPreferences(deps.database);
};
export const writeAdministrationPreferences = async (
  deps: AccountDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  const admin = await guard(deps, request);
  const input = validated(ServerPreferencesRequest, body);
  await atomicallyOn(deps.database)(async (tx) => {
    await changeServerPreferences(tx, deps.clock, admin, input);
  });
};
export const writeAdministrationAdmission = async (
  deps: AccountDependencies,
  request: Request,
  userId: string,
  body: unknown,
): Promise<void> => {
  const admin = await guard(deps, request);
  const id = validated(Uuid, userId);
  const input = validated(ServerAdmissionRequest, body);
  const ended = await atomicallyOn(deps.database)(
    async (tx) => await decideAdmission(tx, deps.clock, admin, id, input.decision),
  );
  await publishAfterCommit(deps.log, [
    [publication('SESSION_ENDED', () => publishSessionsEnded(deps.bus, deps.clock, ended))],
  ]);
};
/** A restricted session may discover only its own admission state. It cannot obtain a workspace context. */
export const readOwnAdmission = async (
  deps: AccountDependencies,
  request: Request,
): Promise<OwnAdmission> => {
  const owner = await sessionFromHeaders(deps.auth, request.headers, { allowPending: true });
  if (owner === undefined) return { state: null };
  const row = await deps.database
    .selectFrom('users')
    .select(['admission_state', 'admission_requires_verified_email', 'email_verified'])
    .where('id', '=', owner.userId)
    .executeTakeFirstOrThrow();
  return {
    state: admissionStateOf({
      admissionState: row.admission_state,
      admissionRequiresVerifiedEmail: row.admission_requires_verified_email,
      emailVerified: row.email_verified,
    }),
  };
};

export const readAdministrationBackups = async (
  deps: AdministrationDependencies,
  request: Request,
): Promise<ServerBackupStatus> => {
  await guard(deps, request);
  return await readBackupEvidence(deps.config.BACKUP_STATUS_DIRECTORY, deps.clock.now());
};
