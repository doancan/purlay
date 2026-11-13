/** Owners change policy only from current allowed authority and an exact, consumed real test. */
import { isDeepStrictEqual } from 'node:util';
import { Value } from '@sinclair/typebox/value';
import { PAGE_LIMIT, Uuid } from '@purlay/types';
import type {
  PreviewWorkspacePolicyRequest,
  UpdateWorkspacePolicyRequest,
  WorkspaceAccessPolicy,
  WorkspacePolicyImpact,
  WorkspacePolicyPreview,
} from '@purlay/types/workspace-security';
import { AppError } from '../../../platform/errors';
import {
  readWorkspacePolicyPreviewPage,
  type WorkspacePolicyPreviewCursor,
} from '../../../platform/workspace-access-facts';
import { evaluateWorkspacePolicyProposal } from '../../../platform/workspace-access';
import { atomicallyOn } from '../../../platform/transactions';
import { recordAudit } from '../../audit/audit';
import { workspaceAccessStatus, workspacePolicyProposalStatus } from './access';
import {
  lockWorkspaceSecurityActor,
  requireFreshSecurityPrimary,
  securityNotReady,
  type WorkspaceSecurityActor,
} from './authority';
import {
  lockPolicyActorFactors,
  requireCurrentPolicyAccess,
  requirePolicyReadersReady,
  type WorkspacePolicyDependencies,
} from './policy-authority';
import { retainWorkspacePolicyDeadlines } from './policy-effects';
import {
  canonicalWorkspacePolicy,
  lockPolicyRow,
  policyProviderBindings,
  policySettings,
  storeWorkspacePolicy,
  workspacePolicyDigest,
  workspacePolicyView,
} from './policy-state';
import {
  consumePolicyTest,
  lockPolicyTest,
  requireTestMfaCurrent,
  validatePolicyTest,
} from './policy-tests';
import { workspaceRecoveryReadiness } from './recovery-state';

export type { WorkspacePolicyDependencies } from './policy-authority';
export { testWorkspacePolicy } from './policy-tests';
export { createWorkspacePolicyRecovery, recoverWorkspacePolicy } from './recovery';

export const readWorkspacePolicy = async (
  dependencies: WorkspacePolicyDependencies,
  actor: WorkspaceSecurityActor,
): Promise<WorkspaceAccessPolicy> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const locked = await lockWorkspaceSecurityActor(
      transaction,
      dependencies,
      actor,
      'administrator',
    );
    const current = await lockPolicyRow(transaction, locked);
    await lockPolicyActorFactors(transaction, locked);
    await requireCurrentPolicyAccess(transaction, dependencies, actor);
    return workspacePolicyView(current, locked.workspace.access_policy_epoch);
  });

export const previewWorkspacePolicy = async (
  dependencies: WorkspacePolicyDependencies,
  actor: WorkspaceSecurityActor,
  request: PreviewWorkspacePolicyRequest,
): Promise<WorkspacePolicyPreview> =>
  await atomicallyOn(dependencies.database)(async (transaction) => {
    const locked = await lockWorkspaceSecurityActor(
      transaction,
      dependencies,
      actor,
      'administrator',
    );
    const current = await lockPolicyRow(transaction, locked, request.revision);
    await lockPolicyActorFactors(transaction, locked);
    await requireCurrentPolicyAccess(transaction, dependencies, actor);
    const settings = canonicalWorkspacePolicy(request.policy);
    await policyProviderBindings(transaction, locked.context.workspaceId, settings, 'policy');
    if (request.before !== undefined && !Value.Check(Uuid, request.before))
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'The request did not match the contract.',
        details: { fields: { before: 'Use the returned preview cursor.' } },
      });
    const limit = Math.min(PAGE_LIMIT.max, request.limit ?? PAGE_LIMIT.default);
    const examples: WorkspacePolicyImpact[] = [];
    const now = dependencies.clock.now();
    let memberCount = 0;
    let guestCount = 0;
    let affectedMemberCount = 0;
    let affectedGuestCount = 0;
    let affectedSessionCount = 0;
    let after: WorkspacePolicyPreviewCursor | undefined;
    let person: WorkspacePolicyImpact | undefined;
    const priority = {
      allowed: 0,
      mfa_required: 1,
      mfa_enrollment_required: 2,
      sign_in_required: 3,
      expired: 4,
    } as const;
    const finish = (): void => {
      if (person === undefined) return;
      if (person.accessKind === 'guest') guestCount += 1;
      else memberCount += 1;
      if (person.state !== 'allowed') {
        if (person.accessKind === 'guest') affectedGuestCount += 1;
        else affectedMemberCount += 1;
        if (
          (request.before === undefined || person.userId > request.before) &&
          examples.length <= limit
        )
          examples.push(person);
      }
    };
    for (;;) {
      const page = await readWorkspacePolicyPreviewPage(transaction, {
        workspaceId: locked.context.workspaceId,
        limit: 100,
        now,
        lifetime: dependencies.lifetime(),
        ...(after === undefined ? {} : { after }),
      });
      for (const row of page.rows) {
        if (person?.userId !== row.userId) {
          finish();
          person = {
            userId: row.userId,
            displayName: row.displayName,
            accessKind: row.accessKind === 'guest' ? 'guest' : 'member',
            state: 'allowed',
            affectedSessions: 0,
          };
        }
        const decision = evaluateWorkspacePolicyProposal(
          {
            sessionId: row.sessionId ?? '',
            userId: row.userId,
            workspaceIds: [locked.context.workspaceId],
            now,
            lifetime: dependencies.lifetime(),
          },
          locked.context.workspaceId,
          row.facts,
          settings,
        );
        if (priority[decision.status.state] > priority[person.state])
          person.state = decision.status.state;
        if (!decision.allowed && row.sessionId !== null) {
          person.affectedSessions += 1;
          affectedSessionCount += 1;
        }
      }
      if (page.next === null) {
        finish();
        break;
      }
      after = page.next;
    }
    const ready = await workspaceRecoveryReadiness(
      transaction,
      dependencies,
      locked.context.workspaceId,
    );
    const data = examples.slice(0, limit);
    return {
      revision: current?.revision ?? null,
      proposedDigest: (await workspacePolicyDigest(settings)).toString('hex'),
      memberCount,
      guestCount,
      affectedMemberCount,
      affectedGuestCount,
      affectedSessionCount,
      ownerRecoveryReady: ready.ready,
      examples: {
        data,
        nextCursor: examples.length > limit ? (data.at(-1)?.userId ?? null) : null,
      },
    };
  });

export const updateWorkspacePolicy = async (
  dependencies: WorkspacePolicyDependencies,
  actor: WorkspaceSecurityActor,
  request: UpdateWorkspacePolicyRequest,
): Promise<WorkspaceAccessPolicy> => {
  const settings = canonicalWorkspacePolicy(request.policy);
  // Ask shared topology outside SQL locks, but disclose its refusal only after canonical current access.
  const readinessError: Error | undefined =
    settings.mode === 'enforced'
      ? await requirePolicyReadersReady(dependencies).then(
          () => undefined,
          (error: unknown) =>
            error instanceof Error ? error : new Error('Cannot verify workspace policy rollout.'),
        )
      : undefined;
  return await atomicallyOn(dependencies.database)(async (transaction) => {
    const locked = await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'owner');
    requireFreshSecurityPrimary(dependencies, locked);
    const current = await lockPolicyRow(transaction, locked, request.revision);
    const tested = await lockPolicyTest(transaction, locked, request.testId, request.testToken);
    await validatePolicyTest(
      transaction,
      dependencies,
      locked,
      current,
      tested,
      settings,
      'policy',
    );
    await lockPolicyActorFactors(transaction, locked);
    await requireCurrentPolicyAccess(transaction, dependencies, actor);
    if (readinessError !== undefined) throw readinessError;
    await requireTestMfaCurrent(transaction, dependencies, actor, tested);
    if (
      tested.tested_at === null ||
      (
        await workspacePolicyProposalStatus(
          { ...dependencies, database: transaction },
          actor,
          settings,
        )
      ).state !== 'allowed'
    )
      throw securityNotReady('Finish the exact real policy test before saving.');
    if (isDeepStrictEqual(policySettings(current), settings)) {
      requireFreshSecurityPrimary(dependencies, locked);
      await consumePolicyTest(transaction, tested, dependencies.clock.now());
      return workspacePolicyView(current, locked.workspace.access_policy_epoch);
    }
    await retainWorkspacePolicyDeadlines(
      transaction,
      dependencies,
      locked.context.workspaceId,
      settings,
    );
    requireFreshSecurityPrimary(
      dependencies,
      await lockWorkspaceSecurityActor(transaction, dependencies, actor, 'owner'),
    );
    await requireCurrentPolicyAccess(transaction, dependencies, actor);
    await requireTestMfaCurrent(transaction, dependencies, actor, tested);
    if (
      (
        await workspacePolicyProposalStatus(
          { ...dependencies, database: transaction },
          actor,
          settings,
        )
      ).state !== 'allowed'
    )
      throw securityNotReady('The tested policy no longer permits this owner source.');
    await validatePolicyTest(
      transaction,
      dependencies,
      locked,
      current,
      tested,
      settings,
      'policy',
    );
    await consumePolicyTest(transaction, tested, dependencies.clock.now());
    const saved = await storeWorkspacePolicy(
      transaction,
      dependencies,
      locked,
      settings,
      new Date(tested.tested_at),
    );
    if (
      (await workspaceAccessStatus({ ...dependencies, database: transaction }, actor)).state !==
      'allowed'
    )
      throw securityNotReady('Sign in again before applying this policy.');
    await recordAudit(transaction, dependencies.clock, {
      workspaceId: locked.context.workspaceId,
      actorUserId: locked.context.userId,
      action: 'workspace.security.policy_updated',
      targetType: 'workspace',
      targetId: locked.context.workspaceId,
      metadata: { revision: saved.revision, mode: saved.mode, signIn: saved.sign_in },
    });
    return workspacePolicyView(saved, saved.epoch);
  });
};
