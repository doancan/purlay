/** Workspace policy and scoped MFA extend canonical native authority; secrets are one-time results. */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, Timestamp, UserRole, Uuid } from './models';
import { CreateWorkspaceRequest, Page } from './api';

export const WORKSPACE_MFA_CODE_DIGITS = 6;
export const WORKSPACE_MFA_PERIOD_SECONDS = 30;
export const WORKSPACE_MFA_SECRET_BYTES = 32;
export const WORKSPACE_POLICY_CONNECTIONS_MAX = 16;
export const WORKSPACE_MFA_RECOVERY_CODES_COUNT = 10;
export const WORKSPACE_MFA_CHALLENGE_SECONDS = 5 * 60;
export const WORKSPACE_MFA_PENDING_SECONDS = 10 * 60;
export const WORKSPACE_SECURITY_FRESH_SECONDS = 5 * 60;

export const SessionAuthenticationMethod = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ Type.Literal('password'),
  /* @__PURE__ */ Type.Literal('email_link'),
  /* @__PURE__ */ Type.Literal('github'),
  /* @__PURE__ */ Type.Literal('server_oidc'),
  /* @__PURE__ */ Type.Literal('google'),
  /* @__PURE__ */ Type.Literal('company_oidc'),
]);
export type SessionAuthenticationMethod = Static<typeof SessionAuthenticationMethod>;

const nullableRevision = /* @__PURE__ */ Type.Union([Uuid, /* @__PURE__ */ Type.Null()]);
const nullableTimestamp = /* @__PURE__ */ Type.Union([Timestamp, /* @__PURE__ */ Type.Null()]);
const opaqueToken = /* @__PURE__ */ Type.String({
  minLength: 43,
  maxLength: 43,
  pattern: '^[A-Za-z0-9_-]{43}$',
});
const recoveryCode = /* @__PURE__ */ Type.String({
  minLength: 22,
  maxLength: 22,
  pattern: '^[A-Za-z0-9_-]{22}$',
});
const otpCode = /* @__PURE__ */ Type.String({
  minLength: WORKSPACE_MFA_CODE_DIGITS,
  maxLength: WORKSPACE_MFA_CODE_DIGITS,
  pattern: `^[0-9]{${String(WORKSPACE_MFA_CODE_DIGITS)}}$`,
});
const nullableIdle = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ Type.Integer({ minimum: 5, maximum: 1440 }),
  /* @__PURE__ */ Type.Null(),
]);
const nullableMaxAge = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ Type.Integer({ minimum: 1, maximum: 720 }),
  /* @__PURE__ */ Type.Null(),
]);
const policyFields = {
  mode: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('off'),
    /* @__PURE__ */ Type.Literal('enforced'),
  ]),
  /** Company-only sign-in covers full members; guests retain independent sign-in but obey MFA/time limits. */
  signIn: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('any'),
    /* @__PURE__ */ Type.Literal('company'),
  ]),
  allowedConnectionIds: /* @__PURE__ */ Type.Array(Uuid, {
    maxItems: WORKSPACE_POLICY_CONNECTIONS_MAX,
    uniqueItems: true,
  }),
  requireMfa: /* @__PURE__ */ Type.Boolean(),
  idleMinutes: nullableIdle,
  maxAgeHours: nullableMaxAge,
  mfaMaxAgeMinutes: nullableIdle,
};
export const WorkspacePolicySettings = /* @__PURE__ */ FromClient(policyFields);
export type WorkspacePolicySettings = Static<typeof WorkspacePolicySettings>;

export const WorkspaceAccessPolicy = /* @__PURE__ */ Type.Object({
  ...policyFields,
  revision: nullableRevision,
  /** PostgreSQL bigint epochs are never rounded through a JavaScript number. */
  epoch: /* @__PURE__ */ Type.String({ pattern: '^(0|[1-9][0-9]*)$', maxLength: 19 }),
  testedAt: nullableTimestamp,
  updatedAt: nullableTimestamp,
});
export type WorkspaceAccessPolicy = Static<typeof WorkspaceAccessPolicy>;

export const WorkspaceAccessState = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ Type.Literal('allowed'),
  /* @__PURE__ */ Type.Literal('sign_in_required'),
  /* @__PURE__ */ Type.Literal('mfa_enrollment_required'),
  /* @__PURE__ */ Type.Literal('mfa_required'),
  /* @__PURE__ */ Type.Literal('expired'),
]);
export type WorkspaceAccessState = Static<typeof WorkspaceAccessState>;
export const WorkspaceAccessStatus = /* @__PURE__ */ Type.Object({
  workspaceId: Uuid,
  policyRevision: nullableRevision,
  state: WorkspaceAccessState,
  factorScope: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('global'),
    /* @__PURE__ */ Type.Literal('workspace'),
    /* @__PURE__ */ Type.Null(),
  ]),
  authenticatedAt: nullableTimestamp,
  mfaVerifiedAt: nullableTimestamp,
  expiresAt: nullableTimestamp,
});
export type WorkspaceAccessStatus = Static<typeof WorkspaceAccessStatus>;

/** Membership metadata for reaching remediation without loading any workspace conversation. */
export const WorkspaceSecurityLookupQuery = /* @__PURE__ */ FromClient({
  workspace: CreateWorkspaceRequest.properties.slug,
});
export type WorkspaceSecurityLookupQuery = Static<typeof WorkspaceSecurityLookupQuery>;
export const WorkspaceSecurityEntry = /* @__PURE__ */ Type.Object({
  workspaceId: Uuid,
  slug: /* @__PURE__ */ Type.String(),
  name: /* @__PURE__ */ Type.String(),
  role: UserRole,
  accessKind: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('member'),
    /* @__PURE__ */ Type.Literal('guest'),
  ]),
  status: WorkspaceAccessStatus,
});
export type WorkspaceSecurityEntry = Static<typeof WorkspaceSecurityEntry>;

export const PreviewWorkspacePolicyRequest = /* @__PURE__ */ FromClient({
  revision: nullableRevision,
  policy: WorkspacePolicySettings,
  before: /* @__PURE__ */ Type.Optional(
    /* @__PURE__ */ Type.String({ minLength: 1, maxLength: 256 }),
  ),
  limit: /* @__PURE__ */ Type.Optional(/* @__PURE__ */ Type.Integer({ minimum: 1, maximum: 100 })),
});
export type PreviewWorkspacePolicyRequest = Static<typeof PreviewWorkspacePolicyRequest>;
export const WorkspacePolicyTestPurpose = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ Type.Literal('policy'),
  /* @__PURE__ */ Type.Literal('recovery_setup'),
]);
export type WorkspacePolicyTestPurpose = Static<typeof WorkspacePolicyTestPurpose>;
export const TestWorkspacePolicyRequest = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ FromClient({
    revision: nullableRevision,
    policy: WorkspacePolicySettings,
    purpose: /* @__PURE__ */ Type.Optional(WorkspacePolicyTestPurpose),
  }),
  /* @__PURE__ */ FromClient({
    revision: nullableRevision,
    policy: WorkspacePolicySettings,
    purpose: /* @__PURE__ */ Type.Optional(WorkspacePolicyTestPurpose),
    testId: Uuid,
    testToken: opaqueToken,
  }),
]);
export type TestWorkspacePolicyRequest = Static<typeof TestWorkspacePolicyRequest>;

export const WorkspacePolicyImpact = /* @__PURE__ */ Type.Object({
  userId: Uuid,
  displayName: /* @__PURE__ */ Type.String(),
  accessKind: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('member'),
    /* @__PURE__ */ Type.Literal('guest'),
  ]),
  state: WorkspaceAccessState,
  affectedSessions: /* @__PURE__ */ Type.Integer({ minimum: 0 }),
});
export type WorkspacePolicyImpact = Static<typeof WorkspacePolicyImpact>;
export const WorkspacePolicyPreview = /* @__PURE__ */ Type.Object({
  revision: nullableRevision,
  proposedDigest: /* @__PURE__ */ Type.String({
    minLength: 64,
    maxLength: 64,
    pattern: '^[0-9a-f]+$',
  }),
  memberCount: /* @__PURE__ */ Type.Integer({ minimum: 0 }),
  guestCount: /* @__PURE__ */ Type.Integer({ minimum: 0 }),
  affectedMemberCount: /* @__PURE__ */ Type.Integer({ minimum: 0 }),
  affectedGuestCount: /* @__PURE__ */ Type.Integer({ minimum: 0 }),
  affectedSessionCount: /* @__PURE__ */ Type.Integer({ minimum: 0 }),
  ownerRecoveryReady: /* @__PURE__ */ Type.Boolean(),
  examples: /* @__PURE__ */ Page(WorkspacePolicyImpact),
});
export type WorkspacePolicyPreview = Static<typeof WorkspacePolicyPreview>;
export const WorkspacePolicyTest = /* @__PURE__ */ Type.Object({
  testId: Uuid,
  testToken: opaqueToken,
  expiresAt: Timestamp,
  status: WorkspaceAccessStatus,
});
export type WorkspacePolicyTest = Static<typeof WorkspacePolicyTest>;
export const UpdateWorkspacePolicyRequest = /* @__PURE__ */ FromClient({
  revision: nullableRevision,
  policy: WorkspacePolicySettings,
  testId: Uuid,
  testToken: opaqueToken,
});
export type UpdateWorkspacePolicyRequest = Static<typeof UpdateWorkspacePolicyRequest>;

export const WorkspaceMfaFactor = /* @__PURE__ */ Type.Object({
  id: Uuid,
  revision: Uuid,
  state: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('pending'),
    /* @__PURE__ */ Type.Literal('verified'),
    /* @__PURE__ */ Type.Literal('revoked'),
  ]),
  createdAt: Timestamp,
  verifiedAt: nullableTimestamp,
  pendingExpiresAt: nullableTimestamp,
});
export type WorkspaceMfaFactor = Static<typeof WorkspaceMfaFactor>;
export const WorkspaceMfaPurpose = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ Type.Literal('enroll'),
  /* @__PURE__ */ Type.Literal('step_up'),
  /* @__PURE__ */ Type.Literal('policy_test'),
  /* @__PURE__ */ Type.Literal('rotate'),
  /* @__PURE__ */ Type.Literal('disable'),
  /* @__PURE__ */ Type.Literal('recovery_codes'),
]);
export type WorkspaceMfaPurpose = Static<typeof WorkspaceMfaPurpose>;
export const WorkspaceMfaChallenge = /* @__PURE__ */ Type.Object({
  challengeId: opaqueToken,
  policyRevision: nullableRevision,
  purpose: WorkspaceMfaPurpose,
  factorScope: /* @__PURE__ */ Type.Union([
    /* @__PURE__ */ Type.Literal('global'),
    /* @__PURE__ */ Type.Literal('workspace'),
  ]),
  factorId: Uuid,
  factorRevision: Uuid,
  expiresAt: Timestamp,
});
export type WorkspaceMfaChallenge = Static<typeof WorkspaceMfaChallenge>;
export const MyWorkspaceMfa = /* @__PURE__ */ Type.Object({
  factor: /* @__PURE__ */ Type.Union([WorkspaceMfaFactor, /* @__PURE__ */ Type.Null()]),
  pending: /* @__PURE__ */ Type.Union([WorkspaceMfaFactor, /* @__PURE__ */ Type.Null()]),
  recoveryCodesRemaining: /* @__PURE__ */ Type.Integer({
    minimum: 0,
    maximum: WORKSPACE_MFA_RECOVERY_CODES_COUNT,
  }),
  globalMfaAvailable: /* @__PURE__ */ Type.Boolean(),
  status: WorkspaceAccessStatus,
});
export type MyWorkspaceMfa = Static<typeof MyWorkspaceMfa>;

export const StartWorkspaceMfaEnrollmentRequest = /* @__PURE__ */ FromClient({
  policyRevision: nullableRevision,
  factorRevision: nullableRevision,
  authorizationChallengeId: /* @__PURE__ */ Type.Optional(opaqueToken),
});
export type StartWorkspaceMfaEnrollmentRequest = Static<typeof StartWorkspaceMfaEnrollmentRequest>;
export const WorkspaceMfaEnrollment = /* @__PURE__ */ Type.Object({
  factor: WorkspaceMfaFactor,
  challenge: WorkspaceMfaChallenge,
  /** One-time enrollment result; never included in factor inventories. */
  totpURI: /* @__PURE__ */ Type.String({
    minLength: 1,
    maxLength: 2048,
    pattern: '^otpauth://totp/',
  }),
});
export type WorkspaceMfaEnrollment = Static<typeof WorkspaceMfaEnrollment>;
export const StartWorkspaceMfaChallengeRequest = /* @__PURE__ */ FromClient({
  policyRevision: nullableRevision,
  purpose: WorkspaceMfaPurpose,
  factorScope: /* @__PURE__ */ Type.Literal('workspace'),
  testId: /* @__PURE__ */ Type.Optional(Uuid),
});
export type StartWorkspaceMfaChallengeRequest = Static<typeof StartWorkspaceMfaChallengeRequest>;
export const VerifyWorkspaceMfaRequest = /* @__PURE__ */ FromClient({
  challengeId: opaqueToken,
  code: otpCode,
});
export type VerifyWorkspaceMfaRequest = Static<typeof VerifyWorkspaceMfaRequest>;
export const UseWorkspaceMfaRecoveryRequest = /* @__PURE__ */ FromClient({
  challengeId: opaqueToken,
  code: recoveryCode,
});
export type UseWorkspaceMfaRecoveryRequest = Static<typeof UseWorkspaceMfaRecoveryRequest>;
export const WorkspaceMfaRecoveryCodes = /* @__PURE__ */ Type.Object({
  revision: Uuid,
  backupCodes: /* @__PURE__ */ Type.Array(recoveryCode, {
    minItems: WORKSPACE_MFA_RECOVERY_CODES_COUNT,
    maxItems: WORKSPACE_MFA_RECOVERY_CODES_COUNT,
    uniqueItems: true,
  }),
});
export type WorkspaceMfaRecoveryCodes = Static<typeof WorkspaceMfaRecoveryCodes>;
export const WorkspaceMfaVerified = /* @__PURE__ */ Type.Object({
  status: WorkspaceAccessStatus,
  factor: /* @__PURE__ */ Type.Union([WorkspaceMfaFactor, /* @__PURE__ */ Type.Null()]),
  recoveryCodes: /* @__PURE__ */ Type.Optional(WorkspaceMfaRecoveryCodes),
});
export type WorkspaceMfaVerified = Static<typeof WorkspaceMfaVerified>;
export const ChangeWorkspaceMfaRequest = /* @__PURE__ */ FromClient({
  policyRevision: nullableRevision,
  factorRevision: Uuid,
  authorizationChallengeId: opaqueToken,
});
export type ChangeWorkspaceMfaRequest = Static<typeof ChangeWorkspaceMfaRequest>;
export const CreateWorkspacePolicyRecoveryRequest = /* @__PURE__ */ Type.Union([
  /* @__PURE__ */ FromClient({ policyRevision: nullableRevision }),
  /* @__PURE__ */ FromClient({
    policyRevision: nullableRevision,
    testId: Uuid,
    testToken: opaqueToken,
  }),
]);
export type CreateWorkspacePolicyRecoveryRequest = Static<
  typeof CreateWorkspacePolicyRecoveryRequest
>;
export const WorkspacePolicyRecovery = /* @__PURE__ */ Type.Object({
  revision: Uuid,
  recoveryCode: opaqueToken,
});
export type WorkspacePolicyRecovery = Static<typeof WorkspacePolicyRecovery>;
export const RecoverWorkspacePolicyRequest = /* @__PURE__ */ FromClient({
  revision: Uuid,
  recoveryCode: opaqueToken,
});
export type RecoverWorkspacePolicyRequest = Static<typeof RecoverWorkspacePolicyRequest>;
