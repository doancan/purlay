/** Synthetic public metadata and disposable one-time values for HTTP-boundary UI tests. */
import type {
  MyWorkspaceMfa,
  WorkspaceAccessPolicy,
  WorkspaceAccessStatus,
  WorkspaceMfaChallenge,
  WorkspaceMfaEnrollment,
  WorkspaceMfaFactor,
  WorkspaceMfaRecoveryCodes,
  WorkspacePolicyPreview,
  WorkspacePolicyTest,
  WorkspaceSecurityEntry,
} from '@purlay/types/workspace-security';
import { IDS, WHEN } from './fixtures';
import { systemClock } from '../system-clock';

const SECURITY_LATER = new Date(systemClock.now().getTime() + 60 * 60_000).toISOString();
export const SECURITY_STATUS: WorkspaceAccessStatus = {
  workspaceId: IDS.workspace,
  policyRevision: IDS.alice,
  state: 'allowed',
  factorScope: null,
  authenticatedAt: WHEN,
  mfaVerifiedAt: null,
  expiresAt: SECURITY_LATER,
};
export const SECURITY_POLICY: WorkspaceAccessPolicy = {
  mode: 'off',
  signIn: 'any',
  allowedConnectionIds: [],
  requireMfa: false,
  idleMinutes: null,
  maxAgeHours: null,
  mfaMaxAgeMinutes: null,
  revision: IDS.alice,
  epoch: '1',
  testedAt: null,
  updatedAt: WHEN,
};
export const SECURITY_FACTOR: WorkspaceMfaFactor = {
  id: IDS.deploys,
  revision: IDS.bob,
  state: 'verified',
  createdAt: WHEN,
  verifiedAt: WHEN,
  pendingExpiresAt: null,
};
export const SECURITY_MFA: MyWorkspaceMfa = {
  factor: null,
  pending: null,
  recoveryCodesRemaining: 0,
  globalMfaAvailable: false,
  status: SECURITY_STATUS,
};
export const SECURITY_CHALLENGE: WorkspaceMfaChallenge = {
  challengeId: 'c'.repeat(43),
  policyRevision: IDS.alice,
  purpose: 'step_up',
  factorScope: 'workspace',
  factorId: SECURITY_FACTOR.id,
  factorRevision: SECURITY_FACTOR.revision,
  expiresAt: SECURITY_LATER,
};
export const SECURITY_ENROLLMENT: WorkspaceMfaEnrollment = {
  factor: {
    ...SECURITY_FACTOR,
    state: 'pending',
    verifiedAt: null,
    pendingExpiresAt: SECURITY_LATER,
  },
  challenge: { ...SECURITY_CHALLENGE, purpose: 'enroll' },
  totpURI:
    'otpauth://totp/Purlay:synthetic?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Purlay&digits=6&period=30',
};
export const SECURITY_CODES: WorkspaceMfaRecoveryCodes = {
  revision: IDS.incidents,
  backupCodes: Array.from({ length: 10 }, (_, n) => String(n).padStart(22, '0')),
};
export const SECURITY_TEST: WorkspacePolicyTest = {
  testId: IDS.browse,
  testToken: 't'.repeat(43),
  expiresAt: SECURITY_LATER,
  status: SECURITY_STATUS,
};
export const SECURITY_PREVIEW: WorkspacePolicyPreview = {
  revision: IDS.alice,
  proposedDigest: 'a'.repeat(64),
  memberCount: 2,
  guestCount: 1,
  affectedMemberCount: 1,
  affectedGuestCount: 1,
  affectedSessionCount: 3,
  ownerRecoveryReady: true,
  examples: { data: [], nextCursor: null },
};
export const SECURITY_ENTRY: WorkspaceSecurityEntry = {
  workspaceId: IDS.workspace,
  slug: 'acme',
  name: 'acme-eng',
  role: 'owner',
  accessKind: 'member',
  status: SECURITY_STATUS,
};
