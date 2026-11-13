/** Workspace proof evaluation is shared with deferred readers and never acquires new authority. */
import type { Executor } from '@purlay/db';
import type {
  WorkspaceAccessStatus,
  WorkspacePolicySettings,
} from '@purlay/types/workspace-security';
import {
  readWorkspaceAccessFacts,
  type WorkspaceAccessFacts,
  type WorkspaceAccessRead,
  type WorkspaceAccessAssurance,
} from './workspace-access-facts';
export type { WorkspaceAccessRead, WorkspaceAccessFacts } from './workspace-access-facts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
type WorkspaceAccessReason =
  | 'allowed'
  | 'off'
  | 'native_invalid'
  | 'membership_invalid'
  | 'source_invalid'
  | 'policy_invalid'
  | 'primary_unknown'
  | 'primary_expired'
  | 'company_required'
  | 'assurance_missing'
  | 'assurance_changed'
  | 'assurance_ended'
  | 'base_expired'
  | 'mfa_missing'
  | 'mfa_expired';
export interface WorkspaceAccessDecision {
  readonly allowed: boolean;
  readonly reason: WorkspaceAccessReason;
  readonly status: WorkspaceAccessStatus;
  readonly baseExpiresAt: Date | null;
  readonly mfaExpiresAt: Date | null;
}
const at = (value: Date | null | undefined): number =>
  value === null || value === undefined ? NaN : new Date(value).getTime();
const finiteDate = (value: number): Date | null =>
  Number.isFinite(value) ? new Date(value) : null;

export const workspaceNativeDeadline = (
  input: WorkspaceAccessRead,
  facts: WorkspaceAccessFacts,
): number => {
  const session = facts.session;
  if (session === undefined) return NaN;
  return Math.min(
    at(session.expires_at),
    input.lifetime.sessionMaxAgeDays === null
      ? Infinity
      : at(session.created_at) + input.lifetime.sessionMaxAgeDays * 24 * HOUR,
    input.lifetime.sessionIdleTimeoutHours === null
      ? Infinity
      : at(session.last_used_at) + input.lifetime.sessionIdleTimeoutHours * HOUR,
  );
};
export const workspacePrimaryConsistent = (facts: WorkspaceAccessFacts): boolean => {
  const { session, evidence, companyProof } = facts;
  if (
    session === undefined ||
    evidence?.method === null ||
    evidence === undefined ||
    evidence.authenticated_at === null ||
    !Number.isFinite(at(evidence.authenticated_at)) ||
    evidence.session_id !== session.id ||
    evidence.user_id !== session.user_id
  )
    return false;
  if (session.company_workspace_id === null)
    return (
      evidence.method !== 'company_oidc' &&
      evidence.company_workspace_id === null &&
      evidence.company_connection_id === null &&
      evidence.company_authentication_revision === null
    );
  return (
    evidence.method === 'company_oidc' &&
    evidence.company_workspace_id === session.company_workspace_id &&
    companyProof?.live === true &&
    evidence.company_connection_id === companyProof.connection_id &&
    evidence.company_authentication_revision === companyProof.authentication_revision &&
    at(evidence.authenticated_at) === at(companyProof.authenticated_at)
  );
};
export const workspaceBaseDeadline = (
  input: WorkspaceAccessRead,
  facts: WorkspaceAccessFacts,
): number => {
  const enforced = facts.policy?.mode === 'enforced';
  return Math.min(
    workspaceNativeDeadline(input, facts),
    enforced && facts.policy.max_age_hours !== null
      ? at(facts.evidence?.authenticated_at) + facts.policy.max_age_hours * HOUR
      : Infinity,
    enforced && facts.policy.idle_minutes !== null
      ? at(facts.assurance?.last_used_at ?? input.now) + facts.policy.idle_minutes * MINUTE
      : Infinity,
  );
};
export const workspaceMfaDeadline = (
  input: WorkspaceAccessRead,
  facts: WorkspaceAccessFacts,
  verifiedAt: Date,
): number =>
  Math.min(
    workspaceNativeDeadline(input, facts),
    facts.policy?.mode === 'enforced' && facts.policy.mfa_max_age_minutes !== null
      ? at(verifiedAt) + facts.policy.mfa_max_age_minutes * MINUTE
      : Infinity,
  );

/** A captured native event is usable only through the current actual independent global factor. */
export const workspaceNativeMfaEvent = (
  input: WorkspaceAccessRead,
  facts: WorkspaceAccessFacts,
): Date | undefined => {
  const { session, evidence, globalFactor } = facts;
  if (
    session?.company_workspace_id !== null ||
    evidence === undefined ||
    evidence.global_mfa_factor_id !== globalFactor?.id ||
    evidence.global_mfa_factor_revision !== globalFactor.assurance_revision ||
    at(evidence.global_mfa_verified_at) > input.now.getTime() ||
    !Number.isFinite(at(evidence.global_mfa_verified_at))
  )
    return undefined;
  if (
    evidence.global_mfa_method === 'totp' &&
    (evidence.global_mfa_counter === null ||
      globalFactor.last_assurance_counter === null ||
      BigInt(evidence.global_mfa_counter) > BigInt(globalFactor.last_assurance_counter))
  )
    return undefined;
  if (evidence.global_mfa_method !== 'totp' && evidence.global_mfa_method !== 'recovery')
    return undefined;
  return new Date(at(evidence.global_mfa_verified_at));
};

export interface WorkspaceNativeMfaEvent {
  readonly scope: 'global';
  readonly factorId: string;
  readonly factorRevision: string;
  readonly verifiedAt: Date;
}
/** A prior native event cannot reappear as fresh after expiry or policy relaxation. */
export const workspaceAdoptableNativeMfaEvent = (
  input: WorkspaceAccessRead,
  facts: WorkspaceAccessFacts,
): WorkspaceNativeMfaEvent | undefined => {
  const verifiedAt = workspaceNativeMfaEvent(input, facts);
  const factor = facts.globalFactor;
  const old = facts.assurance;
  if (verifiedAt === undefined || factor === undefined) return undefined;
  const changedFactor =
    old?.factor_scope !== 'global' ||
    old.factor_id !== factor.id ||
    old.factor_revision !== factor.assurance_revision;
  if (
    old?.mfa_verified_at !== null &&
    old?.mfa_verified_at !== undefined &&
    (verifiedAt.getTime() < new Date(old.mfa_verified_at).getTime() ||
      (verifiedAt.getTime() === new Date(old.mfa_verified_at).getTime() && !changedFactor))
  )
    return undefined;
  return {
    scope: 'global',
    factorId: factor.id,
    factorRevision: factor.assurance_revision,
    verifiedAt,
  };
};

export const evaluateWorkspaceAccess = (
  input: WorkspaceAccessRead,
  workspaceId: string,
  facts: WorkspaceAccessFacts,
): WorkspaceAccessDecision => {
  const now = input.now.getTime();
  const { session, membership, policy, evidence, assurance } = facts;
  let base = workspaceNativeDeadline(input, facts);
  let mfa = NaN;
  const available =
    facts.workspaceFactor !== undefined
      ? 'workspace'
      : facts.globalFactor !== undefined
        ? 'global'
        : null;
  const answer = (
    reason: WorkspaceAccessReason,
    state: WorkspaceAccessStatus['state'],
  ): WorkspaceAccessDecision => ({
    allowed: state === 'allowed',
    reason,
    baseExpiresAt: finiteDate(base),
    mfaExpiresAt: finiteDate(mfa),
    status: {
      workspaceId,
      policyRevision: policy?.revision ?? null,
      state,
      factorScope: Number.isFinite(mfa)
        ? assurance?.factor_scope === 'global'
          ? 'global'
          : 'workspace'
        : session?.company_workspace_id !== null && available === 'global'
          ? null
          : available,
      authenticatedAt: workspacePrimaryConsistent(facts)
        ? new Date(at(evidence?.authenticated_at)).toISOString()
        : null,
      mfaVerifiedAt:
        Number.isFinite(mfa) &&
        assurance?.mfa_verified_at !== null &&
        assurance?.mfa_verified_at !== undefined
          ? new Date(assurance.mfa_verified_at).toISOString()
          : null,
      expiresAt:
        finiteDate(
          Math.min(base, policy?.mode === 'enforced' && policy.require_mfa ? mfa : Infinity),
        )?.toISOString() ?? null,
    },
  });
  if (
    session?.user_id !== input.userId ||
    session.id !== input.sessionId ||
    session.revoked_at !== null ||
    !Number.isFinite(now) ||
    !Number.isFinite(base) ||
    base <= now
  )
    return answer('native_invalid', 'sign_in_required');
  if (
    membership === undefined ||
    (membership.accessKind === 'guest' &&
      (at(membership.guestSince) > now ||
        !Number.isFinite(at(membership.guestSince)) ||
        (membership.guestExpiresAt !== null && at(membership.guestExpiresAt) <= now)))
  )
    return answer('membership_invalid', 'sign_in_required');
  if (
    session.company_workspace_id !== null &&
    (session.company_workspace_id !== workspaceId ||
      facts.companyProof?.live !== true ||
      (evidence?.method !== null && evidence !== undefined && !workspacePrimaryConsistent(facts)))
  )
    return answer('source_invalid', 'sign_in_required');
  if (
    (policy === undefined && membership.epoch !== '0') ||
    (policy !== undefined && policy.epoch !== membership.epoch)
  )
    return answer('policy_invalid', 'sign_in_required');
  if (assurance !== undefined && assurance.ended_at !== null) {
    base = at(assurance.expires_at);
    return answer('assurance_ended', 'expired');
  }
  if (assurance !== undefined && at(assurance.expires_at) <= now) {
    base = at(assurance.expires_at);
    return answer('base_expired', 'expired');
  }
  if (assurance !== undefined) base = Math.min(base, at(assurance.expires_at));
  let proved = false;
  if (assurance?.factor_scope === 'workspace')
    proved =
      facts.workspaceFactor?.id === assurance.factor_id &&
      facts.workspaceFactor.revision === assurance.factor_revision;
  if (assurance?.factor_scope === 'global') {
    const event = workspaceNativeMfaEvent(input, facts);
    proved =
      event !== undefined &&
      facts.globalFactor?.id === assurance.factor_id &&
      facts.globalFactor.assurance_revision === assurance.factor_revision &&
      at(assurance.mfa_verified_at) <= event.getTime();
  }
  if (
    proved &&
    assurance?.mfa_verified_at !== null &&
    assurance?.mfa_verified_at !== undefined &&
    at(assurance.mfa_verified_at) <= now &&
    assurance.mfa_expires_at !== null
  )
    mfa = Math.min(
      at(assurance.mfa_expires_at),
      workspaceMfaDeadline(input, facts, new Date(assurance.mfa_verified_at)),
    );
  if (policy === undefined || policy.mode === 'off') return answer('off', 'allowed');
  if (!workspacePrimaryConsistent(facts) || at(evidence?.authenticated_at) > now)
    return answer('primary_unknown', 'sign_in_required');
  base = Math.min(
    workspaceBaseDeadline(input, facts),
    assurance === undefined ? Infinity : at(assurance.expires_at),
  );
  if (!Number.isFinite(base) || base <= now) return answer('primary_expired', 'expired');
  if (
    policy.sign_in === 'company' &&
    membership.accessKind !== 'guest' &&
    (session.company_workspace_id !== workspaceId ||
      !policy.allowed_connection_ids.includes(evidence?.company_connection_id ?? ''))
  )
    return answer('company_required', 'sign_in_required');
  if (assurance === undefined)
    return answer(
      'assurance_missing',
      policy.require_mfa
        ? available === null
          ? 'mfa_enrollment_required'
          : 'mfa_required'
        : 'sign_in_required',
    );
  if (
    assurance.authentication_revision !== evidence?.revision ||
    assurance.policy_epoch !== membership.epoch ||
    assurance.policy_revision !== policy.revision
  )
    return answer('assurance_changed', 'sign_in_required');
  if (policy.require_mfa && (!proved || !Number.isFinite(mfa)))
    return answer('mfa_missing', available === null ? 'mfa_enrollment_required' : 'mfa_required');
  if (policy.require_mfa && mfa <= now) return answer('mfa_expired', 'mfa_required');
  return answer('allowed', 'allowed');
};

export const readWorkspaceAccessDecisions = async (
  executor: Executor,
  input: WorkspaceAccessRead,
): Promise<ReadonlyMap<string, WorkspaceAccessDecision>> => {
  const facts = await readWorkspaceAccessFacts(executor, input);
  return new Map([...facts].map(([id, row]) => [id, evaluateWorkspaceAccess(input, id, row)]));
};
export const readWorkspaceAccessDecision = async (
  executor: Executor,
  input: Omit<WorkspaceAccessRead, 'workspaceIds'> & { readonly workspaceId: string },
): Promise<WorkspaceAccessDecision> => {
  const read = { ...input, workspaceIds: [input.workspaceId] };
  const found = (await readWorkspaceAccessDecisions(executor, read)).get(input.workspaceId);
  if (found === undefined) throw new Error('Workspace access decision was lost');
  return found;
};

/** A proposal is a read-only view, never an admission capability or a newly persisted proof. */
export const evaluateWorkspacePolicyProposal = (
  input: WorkspaceAccessRead,
  workspaceId: string,
  facts: WorkspaceAccessFacts,
  settings: WorkspacePolicySettings,
): WorkspaceAccessDecision => {
  const current = evaluateWorkspaceAccess(input, workspaceId, facts);
  if (
    [
      'native_invalid',
      'membership_invalid',
      'source_invalid',
      'policy_invalid',
      'assurance_ended',
      'base_expired',
      'primary_expired',
    ].includes(current.reason)
  )
    return current;
  const epoch = String(BigInt(facts.membership?.epoch ?? '0') + 1n);
  const revision = facts.policy?.revision ?? '00000000-0000-0000-0000-000000000000';
  const old = facts.assurance;
  const native = workspaceAdoptableNativeMfaEvent(input, facts);
  let assurance: WorkspaceAccessAssurance | undefined =
    old === undefined
      ? undefined
      : {
          ...old,
          policy_epoch: epoch,
          policy_revision: revision,
          expires_at: new Date(
            Math.min(at(old.expires_at), current.baseExpiresAt?.getTime() ?? Infinity),
          ),
          mfa_expires_at:
            old.mfa_expires_at === null
              ? null
              : new Date(
                  Math.min(at(old.mfa_expires_at), current.mfaExpiresAt?.getTime() ?? Infinity),
                ),
        };
  const proposed: WorkspaceAccessFacts = {
    ...facts,
    membership: facts.membership === undefined ? undefined : { ...facts.membership, epoch },
    policy: {
      workspace_id: workspaceId,
      epoch,
      revision,
      mode: settings.mode,
      sign_in: settings.signIn,
      allowed_connection_ids: settings.allowedConnectionIds,
      require_mfa: settings.requireMfa,
      idle_minutes: settings.idleMinutes,
      max_age_hours: settings.maxAgeHours,
      mfa_max_age_minutes: settings.mfaMaxAgeMinutes,
      tested_at: null,
      updated_by: null,
      created_at: input.now,
      updated_at: input.now,
    },
    assurance,
  };
  if (
    assurance === undefined &&
    workspacePrimaryConsistent(facts) &&
    facts.evidence !== undefined
  ) {
    assurance = {
      workspace_id: workspaceId,
      session_id: input.sessionId,
      user_id: input.userId,
      authentication_revision: facts.evidence.revision,
      policy_epoch: epoch,
      policy_revision: revision,
      factor_scope: null,
      factor_id: null,
      factor_revision: null,
      mfa_verified_at: null,
      mfa_expires_at: null,
      last_used_at: input.now,
      expires_at: new Date(
        Math.min(
          workspaceBaseDeadline(input, proposed),
          current.baseExpiresAt?.getTime() ?? Infinity,
        ),
      ),
      ended_at: null,
      end_reason: null,
      created_at: input.now,
      updated_at: input.now,
    };
  }
  if (assurance !== undefined && native !== undefined)
    assurance = {
      ...assurance,
      factor_scope: 'global',
      factor_id: native.factorId,
      factor_revision: native.factorRevision,
      mfa_verified_at: native.verifiedAt,
      mfa_expires_at: new Date(workspaceMfaDeadline(input, proposed, native.verifiedAt)),
    };
  const result = evaluateWorkspaceAccess(input, workspaceId, { ...proposed, assurance });
  return {
    ...result,
    status: { ...result.status, policyRevision: facts.policy?.revision ?? null },
  };
};
