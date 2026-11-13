/** Canonical settings, exact provider configuration fences and lossless policy views. */
import { sql, type Database, type Selectable, type Transaction } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import {
  WorkspacePolicySettings,
  type WorkspaceAccessPolicy,
  type WorkspacePolicyTestPurpose,
} from '@purlay/types/workspace-security';
import { AppError } from '../../../platform/errors';
import { tokenDigest } from '../../../platform/tokens';
import { identityMissing } from '../identity/authority';
import { securityNotReady, type LockedWorkspaceSecurityActor } from './authority';
import type { WorkspacePolicyDependencies } from './policy-authority';
export { lockMfaPolicy as lockPolicyRow } from './mfa-state';

export type PolicyRow = Selectable<Database['workspace_access_policies']>;
export type PolicyTestRow = Selectable<Database['workspace_access_policy_tests']>;

export const defaultWorkspacePolicy = (): WorkspacePolicySettings => ({
  mode: 'off',
  signIn: 'any',
  allowedConnectionIds: [],
  requireMfa: false,
  idleMinutes: null,
  maxAgeHours: null,
  mfaMaxAgeMinutes: null,
});

export const canonicalWorkspacePolicy = (
  settings: WorkspacePolicySettings,
): WorkspacePolicySettings => {
  if (!Value.Check(WorkspacePolicySettings, settings))
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The request did not match the contract.',
      details: { fields: { policy: 'Enter a valid bounded workspace policy.' } },
    });
  return {
    mode: settings.mode,
    signIn: settings.signIn,
    allowedConnectionIds: [
      ...new Set(settings.allowedConnectionIds.map((id) => id.toLowerCase())),
    ].sort(),
    requireMfa: settings.requireMfa,
    idleMinutes: settings.idleMinutes,
    maxAgeHours: settings.maxAgeHours,
    mfaMaxAgeMinutes: settings.mfaMaxAgeMinutes,
  };
};

export const policySettings = (row: PolicyRow | undefined): WorkspacePolicySettings =>
  row === undefined
    ? defaultWorkspacePolicy()
    : canonicalWorkspacePolicy({
        mode: row.mode as WorkspacePolicySettings['mode'],
        signIn: row.sign_in as WorkspacePolicySettings['signIn'],
        allowedConnectionIds: row.allowed_connection_ids,
        requireMfa: row.require_mfa,
        idleMinutes: row.idle_minutes,
        maxAgeHours: row.max_age_hours,
        mfaMaxAgeMinutes: row.mfa_max_age_minutes,
      });

export const workspacePolicyView = (
  row: PolicyRow | undefined,
  epoch: string,
): WorkspaceAccessPolicy => ({
  ...policySettings(row),
  revision: row?.revision ?? null,
  epoch,
  testedAt:
    row?.tested_at === null || row?.tested_at === undefined
      ? null
      : new Date(row.tested_at).toISOString(),
  updatedAt: row === undefined ? null : new Date(row.updated_at).toISOString(),
});

export const workspacePolicyDigest = async (settings: WorkspacePolicySettings): Promise<Buffer> =>
  Buffer.from(
    await tokenDigest(
      `purlay:workspace-policy:v1:${JSON.stringify(canonicalWorkspacePolicy(settings))}`,
    ),
    'hex',
  );
export const policyTestToken = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
export const policyTestDigest = async (token: string): Promise<Buffer> =>
  Buffer.from(await tokenDigest(`purlay:workspace-policy-test:v1:${token}`), 'hex');

interface ProviderBinding {
  readonly revision: string;
  readonly authenticationRevision: string;
  readonly testedAuthenticationRevision: string | null;
  readonly domainId: string;
  readonly domainRevision: string;
  readonly enabled: boolean;
  readonly ready: boolean;
}
interface PolicyTestBindings {
  readonly purpose: WorkspacePolicyTestPurpose;
  readonly connections: Readonly<Record<string, ProviderBinding>>;
}

export const policyProviderBindings = async (
  transaction: Transaction,
  workspaceId: string,
  settings: WorkspacePolicySettings,
  purpose: WorkspacePolicyTestPurpose,
): Promise<PolicyTestBindings> => {
  if (
    settings.mode === 'enforced' &&
    settings.signIn === 'company' &&
    settings.allowedConnectionIds.length === 0
  )
    throw securityNotReady(
      'Select at least one tested and enabled company provider before requiring company sign-in.',
    );
  const connections: Record<string, ProviderBinding> = {};
  if (settings.allowedConnectionIds.length === 0) return { purpose, connections };
  const rows = await transaction
    .selectFrom('workspace_identity_connections as connection')
    .innerJoin('workspace_identity_domains as domain', (join) =>
      join
        .onRef('domain.workspace_id', '=', 'connection.workspace_id')
        .onRef('domain.id', '=', 'connection.domain_id'),
    )
    .select([
      'connection.id',
      'connection.revision',
      'connection.authentication_revision',
      'connection.tested_authentication_revision',
      'connection.enabled',
      'connection.deleted_at',
      'domain.id as domainId',
      'domain.revision as domainRevision',
      'domain.verified_at',
      'domain.revoked_at',
      sql<boolean>`connection.client_secret_encrypted is not null`.as('hasSecret'),
    ])
    .where('connection.workspace_id', '=', workspaceId)
    .where('connection.id', 'in', settings.allowedConnectionIds)
    .orderBy('connection.id')
    .execute();
  if (rows.length !== settings.allowedConnectionIds.length) throw identityMissing();
  for (const row of rows) {
    const ready =
      row.enabled &&
      row.deleted_at === null &&
      row.hasSecret &&
      row.tested_authentication_revision === row.authentication_revision &&
      row.verified_at !== null &&
      row.revoked_at === null;
    if (
      purpose === 'policy' &&
      settings.mode === 'enforced' &&
      settings.signIn === 'company' &&
      !ready
    )
      throw securityNotReady(
        'Every allowed company provider must be tested, enabled and backed by a verified domain.',
      );
    connections[row.id] = {
      revision: row.revision,
      authenticationRevision: row.authentication_revision,
      testedAuthenticationRevision: row.tested_authentication_revision,
      domainId: row.domainId,
      domainRevision: row.domainRevision,
      enabled: row.enabled,
      ready,
    };
  }
  return { purpose, connections };
};

/** The workspace retains its monotonic epoch even when a policy row is absent or enforcement is off. */
export const storeWorkspacePolicy = async (
  transaction: Transaction,
  dependencies: WorkspacePolicyDependencies,
  locked: LockedWorkspaceSecurityActor,
  settings: WorkspacePolicySettings,
  testedAt: Date,
): Promise<PolicyRow> => {
  const next = BigInt(locked.workspace.access_policy_epoch) + 1n;
  if (next > 9_223_372_036_854_775_807n)
    throw securityNotReady('Workspace policy epoch capacity is exhausted.');
  const now = dependencies.clock.now();
  const revision = crypto.randomUUID();
  const values = {
    epoch: String(next),
    revision,
    mode: settings.mode,
    sign_in: settings.signIn,
    allowed_connection_ids: settings.allowedConnectionIds,
    require_mfa: settings.requireMfa,
    idle_minutes: settings.idleMinutes,
    max_age_hours: settings.maxAgeHours,
    mfa_max_age_minutes: settings.mfaMaxAgeMinutes,
    tested_at: testedAt,
    updated_by: locked.context.userId,
    updated_at: now,
  };
  await transaction
    .updateTable('workspaces')
    .set({ access_policy_epoch: String(next) })
    .where('id', '=', locked.context.workspaceId)
    .execute();
  return await transaction
    .insertInto('workspace_access_policies')
    .values({ workspace_id: locked.context.workspaceId, ...values })
    .onConflict((conflict) => conflict.column('workspace_id').doUpdateSet(values))
    .returningAll()
    .executeTakeFirstOrThrow();
};
