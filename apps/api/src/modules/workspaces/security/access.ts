/** Foreground materialization of actual authentication proof; background readers only evaluate it. */
import { type Transaction } from '@purlay/db';
import type {
  WorkspaceAccessStatus,
  WorkspacePolicySettings,
} from '@purlay/types/workspace-security';
import { AppError } from '../../../platform/errors';
import { assertSecurityMinted } from '../../../platform/tenancy';
import { atomicallyOn } from '../../../platform/transactions';
import {
  readWorkspaceAccessFacts,
  type WorkspaceAccessFacts,
  type WorkspaceAccessRead,
} from '../../../platform/workspace-access-facts';
import {
  evaluateWorkspaceAccess,
  evaluateWorkspacePolicyProposal,
  workspaceAdoptableNativeMfaEvent,
  workspaceBaseDeadline,
  workspaceMfaDeadline,
  workspacePrimaryConsistent,
} from '../../../platform/workspace-access';
import {
  lockWorkspaceSecurityActor,
  securityNotReady,
  type WorkspaceSecurityActor,
  type WorkspaceSecurityDependencies,
} from './authority';

const reauthenticate = (): AppError =>
  new AppError({
    code: 'REAUTHENTICATION_REQUIRED',
    message: 'Sign in again before workspace verification.',
  });
const readInput = (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
): WorkspaceAccessRead => ({
  sessionId: actor.sessionId,
  userId: actor.context.userId,
  workspaceIds: [actor.context.workspaceId],
  now: dependencies.clock.now(),
  lifetime: dependencies.lifetime(),
});

/** Native session → workspace/member → policy → factor → assurance, matching MFA/policy writers. */
const lockedFacts = async (
  transaction: Transaction,
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  input: WorkspaceAccessRead,
): Promise<WorkspaceAccessFacts> => {
  const locked = await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'self');
  await transaction
    .selectFrom('workspace_access_policies')
    .select('workspace_id')
    .where('workspace_id', '=', actor.context.workspaceId)
    .forUpdate()
    .execute();
  await transaction
    .selectFrom('workspace_mfa_factors')
    .select('id')
    .where('workspace_id', '=', actor.context.workspaceId)
    .where('user_id', '=', actor.context.userId)
    .where('state', '=', 'verified')
    .orderBy('id')
    .forShare()
    .execute();
  if (locked.session.company_workspace_id === null)
    await transaction
      .selectFrom('two_factors')
      .select('id')
      .where('user_id', '=', actor.context.userId)
      .forShare()
      .execute();
  await transaction
    .selectFrom('workspace_session_assurances')
    .select('session_id')
    .where('workspace_id', '=', actor.context.workspaceId)
    .where('session_id', '=', actor.sessionId)
    .where('user_id', '=', actor.context.userId)
    .forUpdate()
    .execute();
  const facts = (await readWorkspaceAccessFacts(transaction, input)).get(actor.context.workspaceId);
  if (facts === undefined) throw new Error('Workspace authentication facts were lost');
  return facts;
};
const primaryUsable = (
  input: WorkspaceAccessRead,
  workspaceId: string,
  facts: WorkspaceAccessFacts,
): boolean => {
  if (
    !workspacePrimaryConsistent(facts) ||
    facts.evidence?.authenticated_at === null ||
    facts.evidence === undefined ||
    new Date(facts.evidence.authenticated_at).getTime() > input.now.getTime()
  )
    return false;
  const decision = evaluateWorkspaceAccess(input, workspaceId, facts);
  return (
    ![
      'native_invalid',
      'membership_invalid',
      'source_invalid',
      'policy_invalid',
      'primary_unknown',
      'primary_expired',
      'company_required',
      'assurance_ended',
      'base_expired',
    ].includes(decision.reason) &&
    (facts.assurance === undefined ||
      facts.assurance.authentication_revision === facts.evidence.revision)
  );
};

interface MfaEvent {
  readonly scope: 'global' | 'workspace';
  readonly factorId: string;
  readonly factorRevision: string;
  readonly verifiedAt: Date;
}

/** No status, policy relaxation or MFA refresh may restart base activity or an ended lifetime. */
const materialize = async (
  transaction: Transaction,
  input: WorkspaceAccessRead,
  workspaceId: string,
  facts: WorkspaceAccessFacts,
  freshMfa?: MfaEvent,
): Promise<void> => {
  const evidence = facts.evidence;
  if (evidence === undefined) throw reauthenticate();
  const old = facts.assurance;
  const base = new Date(
    Math.min(
      workspaceBaseDeadline(input, facts),
      old === undefined ? Infinity : new Date(old.expires_at).getTime(),
    ),
  );
  if (
    !Number.isFinite(base.getTime()) ||
    base.getTime() <= input.now.getTime() ||
    (old?.ended_at !== null && old?.ended_at !== undefined)
  )
    throw reauthenticate();
  const mfa =
    freshMfa ??
    (old?.factor_scope === null || old?.factor_scope === undefined
      ? undefined
      : {
          scope: old.factor_scope,
          factorId: old.factor_id,
          factorRevision: old.factor_revision,
          verifiedAt: old.mfa_verified_at,
        });
  const mfaDeadline =
    mfa?.verifiedAt === null || mfa?.verifiedAt === undefined
      ? null
      : new Date(
          Math.min(
            workspaceMfaDeadline(input, facts, new Date(mfa.verifiedAt)),
            freshMfa !== undefined ||
              old?.mfa_expires_at === null ||
              old?.mfa_expires_at === undefined
              ? Infinity
              : new Date(old.mfa_expires_at).getTime(),
          ),
        );
  const values = {
    policy_revision: facts.policy?.revision ?? null,
    policy_epoch: facts.membership?.epoch ?? '0',
    factor_scope: mfa?.scope ?? null,
    factor_id: mfa?.factorId ?? null,
    factor_revision: mfa?.factorRevision ?? null,
    mfa_verified_at: mfa?.verifiedAt ?? null,
    mfa_expires_at: mfaDeadline,
    expires_at: base,
    updated_at: input.now,
  };
  if (old === undefined) {
    await transaction
      .insertInto('workspace_session_assurances')
      .values({
        workspace_id: workspaceId,
        session_id: input.sessionId,
        user_id: input.userId,
        authentication_revision: evidence.revision,
        ...values,
        last_used_at: input.now,
        created_at: input.now,
      })
      .execute();
  } else {
    await transaction
      .updateTable('workspace_session_assurances')
      .set(values)
      .where('workspace_id', '=', workspaceId)
      .where('session_id', '=', input.sessionId)
      .where('user_id', '=', input.userId)
      .where('authentication_revision', '=', evidence.revision)
      .where('ended_at', 'is', null)
      .where('expires_at', '>', input.now)
      .execute();
  }
};

export const workspaceAccessStatus = async (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
): Promise<WorkspaceAccessStatus> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    let input = readInput(dependencies, actor);
    const workspaceId = actor.context.workspaceId;
    const facts = await lockedFacts(transaction, dependencies, actor, input);
    input = { ...input, now: dependencies.clock.now() };
    const initial = evaluateWorkspaceAccess(input, workspaceId, facts);
    if (initial.reason === 'base_expired' || initial.reason === 'primary_expired') {
      await transaction
        .updateTable('workspace_session_assurances')
        .set({ ended_at: input.now, end_reason: 'expired', updated_at: input.now })
        .where('workspace_id', '=', workspaceId)
        .where('session_id', '=', actor.sessionId)
        .where('user_id', '=', actor.context.userId)
        .where('ended_at', 'is', null)
        .execute();
      return initial.status;
    }
    if (!primaryUsable(input, workspaceId, facts)) return initial.status;
    await materialize(
      transaction,
      input,
      workspaceId,
      facts,
      workspaceAdoptableNativeMfaEvent(input, facts),
    );
    const current = (await readWorkspaceAccessFacts(transaction, input)).get(workspaceId);
    if (current === undefined) throw new Error('Workspace authentication facts were lost');
    return evaluateWorkspaceAccess(input, workspaceId, current).status;
  });

/** Called only after native scoped factor/counter and challenge consumption, inside that transaction. */
export const recordWorkspaceMfaVerification = async (
  transaction: Transaction,
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  proof: { readonly factorId: string; readonly factorRevision: string; readonly verifiedAt: Date },
): Promise<void> => {
  let input = readInput(dependencies, actor);
  const workspaceId = actor.context.workspaceId;
  const facts = await lockedFacts(transaction, dependencies, actor, input);
  input = { ...input, now: dependencies.clock.now() };
  if (!primaryUsable(input, workspaceId, facts)) throw reauthenticate();
  if (facts.evidence === undefined || facts.membership === undefined) throw reauthenticate();
  if (
    !Number.isFinite(proof.verifiedAt.getTime()) ||
    proof.verifiedAt.getTime() > input.now.getTime() ||
    facts.workspaceFactor?.id !== proof.factorId ||
    facts.workspaceFactor.revision !== proof.factorRevision ||
    facts.workspaceFactor.verified_at === null ||
    new Date(facts.workspaceFactor.verified_at).getTime() > proof.verifiedAt.getTime()
  )
    throw securityNotReady('Workspace MFA proof is no longer current.');
  const receipt = await transaction
    .selectFrom('workspace_mfa_challenges')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('session_id', '=', actor.sessionId)
    .where('user_id', '=', actor.context.userId)
    .where('authentication_revision', '=', facts.evidence.revision)
    .where('policy_epoch', '=', facts.membership.epoch)
    .where(
      'policy_revision',
      facts.policy === undefined ? 'is' : '=',
      facts.policy?.revision ?? null,
    )
    .where('factor_scope', '=', 'workspace')
    .where('factor_id', '=', proof.factorId)
    .where('factor_revision', '=', proof.factorRevision)
    .where('consumed_at', '=', proof.verifiedAt)
    .where('expires_at', '>', input.now)
    .where('failed_attempts', '=', 0)
    .forShare()
    .executeTakeFirst();
  if (receipt === undefined)
    throw securityNotReady('An accepted workspace MFA challenge is required.');
  const old = facts.assurance;
  if (
    old?.factor_scope === 'workspace' &&
    old.factor_id === proof.factorId &&
    old.factor_revision === proof.factorRevision &&
    old.mfa_verified_at !== null &&
    new Date(old.mfa_verified_at).getTime() === proof.verifiedAt.getTime() &&
    old.policy_epoch === facts.membership.epoch &&
    old.policy_revision === (facts.policy?.revision ?? null)
  )
    return;
  await materialize(transaction, input, workspaceId, facts, { scope: 'workspace', ...proof });
};

/** Advisory self evaluation only; callers authorize policy operations separately. */
export const workspacePolicyProposalStatus = async (
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  policy: WorkspacePolicySettings,
): Promise<WorkspaceAccessStatus> => {
  assertSecurityMinted(actor.context);
  const input = readInput(dependencies, actor);
  const facts = (await readWorkspaceAccessFacts(dependencies.database, input)).get(
    actor.context.workspaceId,
  );
  if (facts === undefined) throw new Error('Workspace authentication facts were lost');
  return evaluateWorkspacePolicyProposal(input, actor.context.workspaceId, facts, policy).status;
};
