/** Server-wide administration metadata. No message content or credentials cross this boundary. */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, Timestamp, Uuid, UserRole } from './models';
import { Page, AUDIT_EXPORT_FORMATS } from './api';

export const ServerAuditAction = Type.Union([
  Type.Literal('server.github_connected'),
  Type.Literal('server.github_disconnected'),
  Type.Literal('server.oidc_connected'),
  Type.Literal('server.oidc_disconnected'),
  Type.Literal('server.google_connected'),
  Type.Literal('server.google_disconnected'),
  Type.Literal('server.github_app_connected'),
  Type.Literal('server.github_app_disconnected'),
  Type.Literal('server.smtp_connected'),
  Type.Literal('server.smtp_disconnected'),
  Type.Literal('server.sign_up_changed'),
  Type.Literal('server.two_factor_requirement_changed'),
  Type.Literal('server.password_sign_in_changed'),
  Type.Literal('server.session_idle_timeout_changed'),
  Type.Literal('server.session_max_age_changed'),
  Type.Literal('server.workspace_creators_changed'),
  Type.Literal('server.admin_password_reset'),
  Type.Literal('server.account_suspended'),
  Type.Literal('server.account_restored'),
  Type.Literal('account.export_requested'),
  Type.Literal('account.export_downloaded'),
  Type.Literal('server.workspace_purged'),
  Type.Literal('server.admin_granted'),
  Type.Literal('server.admin_revoked'),
  Type.Literal('server.sessions_revoked'),
  Type.Literal('server.quota_changed'),
  Type.Literal('server.smtp_tested'),
  Type.Literal('server.admission_policy_changed'),
  Type.Literal('server.identity_changed'),
  Type.Literal('server.account_approved'),
  Type.Literal('server.account_denied'),
  Type.Literal('server.audit_export_requested'),
  Type.Literal('server.module_granted'),
  Type.Literal('server.module_withdrawn'),
  Type.Literal('server.module_reset'),
  Type.Literal('server.module_suspended'),
  Type.Literal('server.module_resumed'),
  Type.Literal('server.fact_inspected'),
]);
export type ServerAuditAction = Static<typeof ServerAuditAction>;

export const AdmissionState = Type.Union([
  Type.Literal('approved'),
  Type.Literal('pending'),
  Type.Literal('denied'),
]);
export type AdmissionState = Static<typeof AdmissionState>;

const pagination = {
  after: Type.Optional(Uuid),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
};
const search = { ...pagination, q: Type.Optional(Type.String({ maxLength: 100 })) };
export const ServerUsersQuery = FromClient({
  ...search,
  status: Type.Optional(
    Type.Union([
      Type.Literal('active'),
      Type.Literal('suspended'),
      Type.Literal('admins'),
      Type.Literal('pending'),
      Type.Literal('denied'),
    ]),
  ),
});
export type ServerUsersQuery = Static<typeof ServerUsersQuery>;
export const ServerWorkspacesQuery = FromClient({
  ...search,
  status: Type.Optional(
    Type.Union([Type.Literal('active'), Type.Literal('deleted'), Type.Literal('full')]),
  ),
});
export type ServerWorkspacesQuery = Static<typeof ServerWorkspacesQuery>;
const auditFilter = {
  action: Type.Optional(ServerAuditAction),
  actorUserId: Type.Optional(Uuid),
  targetUserId: Type.Optional(Uuid),
  targetWorkspaceId: Type.Optional(Uuid),
  from: Type.Optional(Timestamp),
  to: Type.Optional(Timestamp),
};
export const ServerAuditQuery = FromClient({ ...pagination, ...auditFilter });
export type ServerAuditQuery = Static<typeof ServerAuditQuery>;
export const ServerAuditExportQuery = FromClient({
  ...auditFilter,
  format: Type.Union(AUDIT_EXPORT_FORMATS.map((format) => Type.Literal(format))),
});
export type ServerAuditExportQuery = Static<typeof ServerAuditExportQuery>;
export const ServerQuotaRequest = FromClient({
  quotaBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
});
export type ServerQuotaRequest = Static<typeof ServerQuotaRequest>;
/**
 * Grants a workspace one module, withholds it, or lets it have what the server's mode gives it (`inherit`, D-289): the one
 * write of the table `workspace_modules`. `validUntil` ends a grant or a refusal at that instant, when the row is read as none.
 */
export const ServerWorkspaceModuleRequest = FromClient({
  module: Type.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' }),
  state: Type.Union([Type.Literal('on'), Type.Literal('off'), Type.Literal('inherit')]),
  validUntil: Type.Optional(Timestamp),
});
export type ServerWorkspaceModuleRequest = Static<typeof ServerWorkspaceModuleRequest>;
/** The longest a reason for stopping a module may be: the table's own limit and the trail's (D-296). */
export const SUSPENSION_REASON_MAX = 200;
export const ServerAdminRequest = FromClient({ isServerAdmin: Type.Boolean() });
export type ServerAdminRequest = Static<typeof ServerAdminRequest>;
export const ServerUser = Type.Object({
  id: Uuid,
  username: Type.String(),
  displayName: Type.String(),
  email: Type.String(),
  emailVerified: Type.Boolean(),
  admissionState: AdmissionState,
  isServerAdmin: Type.Boolean(),
  suspendedAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
  lastSeenAt: Type.Union([Timestamp, Type.Null()]),
});
export type ServerUser = Static<typeof ServerUser>;
export const ServerUserPage = Page(ServerUser);
export type ServerUserPage = Static<typeof ServerUserPage>;
export const ServerUserDetail = Type.Object({
  user: ServerUser,
  memberships: Type.Array(
    Type.Object({
      workspaceId: Uuid,
      workspaceName: Type.String(),
      workspaceSlug: Type.String(),
      role: UserRole,
    }),
  ),
  nextCursor: Type.Union([Uuid, Type.Null()]),
  activeSessions: Type.Integer({ minimum: 0 }),
});
export type ServerUserDetail = Static<typeof ServerUserDetail>;
/** What the operator has said of one module for one workspace, and what that comes to now (D-289). */
export const ServerWorkspaceModule = Type.Object({
  module: Type.String(),
  /** What the row says: `inherit` when there is none (or it has run out), and the server's mode decides. */
  state: Type.Union([Type.Literal('on'), Type.Literal('off'), Type.Literal('inherit')]),
  /** Whether the workspace may use it now, the module it requires counted. */
  effective: Type.Boolean(),
  validUntil: Type.Union([Timestamp, Type.Null()]),
  source: Type.Union([Type.String(), Type.Null()]),
  /** Whether this process runs the module: a grant for one it does not is kept and does nothing here. */
  running: Type.Boolean(),
});
export type ServerWorkspaceModule = Static<typeof ServerWorkspaceModule>;
export const ServerWorkspace = Type.Object({
  id: Uuid,
  name: Type.String(),
  slug: Type.String(),
  createdAt: Timestamp,
  deletedAt: Type.Union([Timestamp, Type.Null()]),
  purgedAt: Type.Union([Timestamp, Type.Null()]),
  memberCount: Type.Integer({ minimum: 0 }),
  ownerCount: Type.Integer({ minimum: 0 }),
  owners: Type.Array(Type.Object({ id: Uuid, displayName: Type.String() })),
  usedBytes: Type.String({ pattern: '^[0-9]+$' }),
  quotaBytes: Type.String({ pattern: '^[0-9]+$' }),
  retentionDays: Type.Union([Type.Integer(), Type.Null()]),
  /** One entry for each module of the build that a workspace can be granted (D-289). */
  modules: Type.Array(ServerWorkspaceModule),
});
export type ServerWorkspace = Static<typeof ServerWorkspace>;
export const ServerWorkspacePage = Page(ServerWorkspace);
export type ServerWorkspacePage = Static<typeof ServerWorkspacePage>;
export const ServerAuditEntry = Type.Object({
  id: Uuid,
  action: Type.String(),
  actorUserId: Type.Union([Uuid, Type.Null()]),
  actorName: Type.Union([Type.String(), Type.Null()]),
  targetUserId: Type.Union([Uuid, Type.Null()]),
  targetWorkspaceId: Type.Union([Uuid, Type.Null()]),
  /** The module an entry about a grant is about (D-289); null for every other entry. */
  targetModule: Type.Union([Type.String(), Type.Null()]),
  /** The operator's own words for why, on the one entry that carries them (`server.module_suspended`, D-296); null for every other. */
  note: Type.Union([Type.String(), Type.Null()]),
  /** The fact an entry about the outbox is about (D-288 §11), by id; null for every other entry. */
  targetFactId: Type.Union([Uuid, Type.Null()]),
  createdAt: Timestamp,
});
export const ServerAuditPage = Page(ServerAuditEntry);
export type ServerAuditEntry = Static<typeof ServerAuditEntry>;
export type ServerAuditPage = Static<typeof ServerAuditPage>;
export const SERVER_AUDIT_EXPORT_COLUMNS = [
  'id',
  'createdAt',
  'action',
  'actorUserId',
  'actorName',
  'targetUserId',
  'targetWorkspaceId',
  'targetModule',
  'note',
  'targetFactId',
] as const satisfies readonly (keyof ServerAuditEntry)[];
export const ServerJob = Type.Object({
  name: Type.String(),
  status: Type.Union([Type.Literal('never'), Type.Literal('ok'), Type.Literal('overdue')]),
  lastStartedAt: Type.Union([Timestamp, Type.Null()]),
  lastSuccessAt: Type.Union([Timestamp, Type.Null()]),
  durationMs: Type.Union([Type.Integer(), Type.Null()]),
  consecutiveFailures: Type.Integer({ minimum: 0 }),
});
export type ServerJob = Static<typeof ServerJob>;
export const ServerOperations = Type.Object({
  checkedAt: Timestamp,
  jobs: Type.Array(ServerJob),
  staleAfterMs: Type.Integer(),
});
export type ServerOperations = Static<typeof ServerOperations>;
export const ServerOverview = Type.Object({
  checkedAt: Timestamp,
  version: Type.String(),
  appUrl: Type.String(),
  ready: Type.Boolean(),
  modules: Type.Array(Type.String()),
  users: Type.Integer({ minimum: 0 }),
  admins: Type.Integer({ minimum: 0 }),
  suspendedUsers: Type.Integer({ minimum: 0 }),
  workspaces: Type.Integer({ minimum: 0 }),
  deletedWorkspaces: Type.Integer({ minimum: 0 }),
  usedBytes: Type.String({ pattern: '^[0-9]+$' }),
  storage: Type.Union([
    Type.Literal('directory'),
    Type.Literal('s3'),
    Type.Literal('unconfigured'),
  ]),
  pushConfigured: Type.Boolean(),
  sharedStateConfigured: Type.Boolean(),
  exportFailures: Type.Integer({ minimum: 0 }),
  /** Facts between modules given up on after their tries, over every module that consumes one (D-288). */
  outboxDeadFacts: Type.Integer({ minimum: 0 }),
  /** Seconds the longest-waiting fact between modules has waited, 0 where none waits. */
  outboxOldestPendingSeconds: Type.Integer({ minimum: 0 }),
  /** How long a waiting fact may wait before the overview calls it a problem, as the server judges it. */
  outboxStaleAfterSeconds: Type.Integer({ minimum: 1 }),
});
export type ServerOverview = Static<typeof ServerOverview>;

export const ServerMembershipsQuery = FromClient({ after: Type.Optional(Uuid) });
export const ServerEmptyRequest = FromClient({});
export const ServerMailTest = Type.Object({
  testedAt: Timestamp,
  accepted: Type.Boolean(),
  host: Type.String(),
  reason: Type.Union([Type.String(), Type.Null()]),
});
export type ServerMailTest = Static<typeof ServerMailTest>;
export const ServerMailStatus = Type.Object({
  lastTest: Type.Union([ServerMailTest, Type.Null()]),
});
export type ServerMailStatus = Static<typeof ServerMailStatus>;

const preferences = {
  allowedEmailDomains: Type.Array(
    Type.String({
      minLength: 3,
      maxLength: 253,
      pattern:
        '^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$',
    }),
    { maxItems: 50, uniqueItems: true },
  ),
  requireAccountApproval: Type.Boolean(),
  displayName: Type.String({ minLength: 1, maxLength: 100 }),
  supportUrl: Type.Union([Type.String({ minLength: 1, maxLength: 2048 }), Type.Null()]),
};
export const ServerPreferencesRequest = FromClient(
  {
    allowedEmailDomains: Type.Optional(preferences.allowedEmailDomains),
    requireAccountApproval: Type.Optional(preferences.requireAccountApproval),
    displayName: Type.Optional(preferences.displayName),
    supportUrl: Type.Optional(preferences.supportUrl),
  },
  { minProperties: 1 },
);
export type ServerPreferencesRequest = Static<typeof ServerPreferencesRequest>;
export const ServerPreferences = Type.Object(preferences);
export type ServerPreferences = Static<typeof ServerPreferences>;
export const ServerAdmissionRequest = FromClient({
  decision: Type.Union([Type.Literal('approved'), Type.Literal('denied')]),
});
export type ServerAdmissionRequest = Static<typeof ServerAdmissionRequest>;
export const SERVER_APPROVAL_BATCH_MAX = 50;
export const ServerBatchApprovalRequest = FromClient({
  userIds: Type.Array(Uuid, {
    minItems: 1,
    maxItems: SERVER_APPROVAL_BATCH_MAX,
    uniqueItems: true,
  }),
});
export type ServerBatchApprovalRequest = Static<typeof ServerBatchApprovalRequest>;
export const ServerApprovalOutcome = Type.Union([
  Type.Literal('approved'),
  Type.Literal('refused'),
  Type.Literal('unconfirmed'),
  Type.Literal('not_processed'),
]);
export const ServerBatchApprovalResponse = Type.Object({
  results: Type.Array(Type.Object({ userId: Uuid, outcome: ServerApprovalOutcome }), {
    minItems: 1,
    maxItems: SERVER_APPROVAL_BATCH_MAX,
  }),
});
export type ServerBatchApprovalResponse = Static<typeof ServerBatchApprovalResponse>;
export const OwnAdmission = Type.Object({
  state: Type.Union([AdmissionState, Type.Literal('verify-email'), Type.Null()]),
});
export type OwnAdmission = Static<typeof OwnAdmission>;
export const InstanceInfo = Type.Object(preferences);
export type InstanceInfo = Static<typeof InstanceInfo>;

export const BackupScope = Type.Union([
  Type.Literal('database'),
  Type.Literal('database-and-attachments'),
]);
export const BackupEvidence = FromClient({
  version: Type.Literal(1),
  source: Type.Union([Type.Literal('backup-script'), Type.Literal('dockhand')]),
  completedAt: Timestamp,
  scope: BackupScope,
  databaseSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  databaseBytes: Type.String({ pattern: '^[1-9][0-9]{0,19}$' }),
  maxAgeSeconds: Type.Integer({ minimum: 60, maximum: 31_536_000 }),
});
export type BackupEvidence = Static<typeof BackupEvidence>;
export const RestoreEvidence = FromClient({
  version: Type.Literal(1),
  source: Type.Literal('restore-script'),
  checkedAt: Timestamp,
  scope: BackupScope,
  databaseSha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
});
export type RestoreEvidence = Static<typeof RestoreEvidence>;
export const ServerBackupStatus = Type.Object({
  state: Type.Union([
    Type.Literal('unconfigured'),
    Type.Literal('unreported'),
    Type.Literal('invalid'),
    Type.Literal('current'),
    Type.Literal('stale'),
  ]),
  checkedAt: Timestamp,
  backup: Type.Union([BackupEvidence, Type.Null()]),
  restore: Type.Union([RestoreEvidence, Type.Null()]),
  restoreMatchesLatest: Type.Boolean(),
});
export type ServerBackupStatus = Static<typeof ServerBackupStatus>;

/** What the operator's list of the outbox can be asked for (D-288 §11): `stuck` is pending past the overview's fifteen minutes. */
export const ServerOutboxState = Type.Union([
  Type.Literal('dead'),
  Type.Literal('stuck'),
  Type.Literal('discarded'),
]);
export type ServerOutboxState = Static<typeof ServerOutboxState>;
export const ServerOutboxQuery = FromClient({
  state: Type.Optional(ServerOutboxState),
  consumer: Type.Optional(Type.String({ pattern: '^[a-z][a-z0-9-]{0,31}$' })),
  type: Type.Optional(
    Type.String({ pattern: '^[a-z][a-z0-9-]*\\.[a-z][a-z0-9-]*$', maxLength: 80 }),
  ),
  workspaceId: Type.Optional(Uuid),
  after: Type.Optional(Uuid),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export type ServerOutboxQuery = Static<typeof ServerOutboxQuery>;
/** A delivery of a fact, as metadata: never the payload, which only the one-row read shows. */
export const ServerOutboxFact = Type.Object({
  id: Uuid,
  factId: Uuid,
  type: Type.String(),
  shape: Type.Integer({ minimum: 1 }),
  workspaceId: Uuid,
  producer: Type.String(),
  consumer: Type.String(),
  state: Type.String(),
  attempts: Type.Integer({ minimum: 0 }),
  /** A class of error, at most 300 characters (D-288 §1). */
  lastError: Type.Union([Type.String(), Type.Null()]),
  createdAt: Timestamp,
  nextAttemptAt: Timestamp,
  finishedAt: Type.Union([Timestamp, Type.Null()]),
});
export type ServerOutboxFact = Static<typeof ServerOutboxFact>;
export const ServerOutboxPage = Page(ServerOutboxFact);
export type ServerOutboxPage = Static<typeof ServerOutboxPage>;
export const ServerOutboxFactDetail = Type.Composite([
  ServerOutboxFact,
  Type.Object({
    payload: Type.Unknown(),
    correlationId: Type.Union([Type.String(), Type.Null()]),
    causedBy: Type.Union([Uuid, Type.Null()]),
  }),
]);
export type ServerOutboxFactDetail = Static<typeof ServerOutboxFactDetail>;
