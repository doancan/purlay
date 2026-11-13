/** Administrative policy decisions use current native access, public sign-in availability and deployment readiness. */
import type { AuthMethods } from '@purlay/types';
import type { Transaction } from '@purlay/db';
import { AppError } from '../../../platform/errors';
import { workspaceAccessStatus } from './access';
import {
  type LockedWorkspaceSecurityActor,
  type WorkspaceSecurityActor,
  type WorkspaceSecurityDependencies,
} from './authority';

export interface WorkspacePolicyDependencies extends WorkspaceSecurityDependencies {
  /** The native auth facade's public configured methods, never provider secrets. */
  readonly signInMethods: () => AuthMethods;
  /** Operator rollout attestation AND absence of known incompatible API peers; missing/unknown is not ready. */
  readonly policyReadersReady: () => Promise<boolean>;
}

/** Effective factor locks precede recovery/challenge receipts and assurance materialization. */
export const lockPolicyActorFactors = async (
  transaction: Transaction,
  locked: LockedWorkspaceSecurityActor,
): Promise<void> => {
  await transaction
    .selectFrom('workspace_mfa_factors')
    .select('id')
    .where('workspace_id', '=', locked.context.workspaceId)
    .where('user_id', '=', locked.context.userId)
    .where('state', '=', 'verified')
    .orderBy('id')
    .forShare()
    .execute();
  if (locked.session.company_workspace_id === null)
    await transaction
      .selectFrom('two_factors')
      .select('id')
      .where('user_id', '=', locked.context.userId)
      .forShare()
      .execute();
};

export const requireCurrentPolicyAccess = async (
  transaction: Transaction,
  dependencies: WorkspacePolicyDependencies,
  actor: WorkspaceSecurityActor,
): Promise<Awaited<ReturnType<typeof workspaceAccessStatus>>> => {
  const current = await workspaceAccessStatus({ ...dependencies, database: transaction }, actor);
  if (current.state !== 'allowed')
    throw new AppError({
      code: 'WORKSPACE_ACCESS_REQUIRED',
      message: 'Complete the current workspace sign-in requirements before managing its policy.',
    });
  return current;
};

export const requirePolicyReadersReady = async (
  dependencies: Partial<Pick<WorkspacePolicyDependencies, 'policyReadersReady'>>,
): Promise<void> => {
  let ready = false;
  try {
    const observed: unknown =
      typeof dependencies.policyReadersReady === 'function'
        ? await dependencies.policyReadersReady()
        : false;
    ready = observed === true;
  } catch {
    /* Unknown topology cannot authorize enforcement. */
  }
  if (!ready)
    throw new AppError({
      code: 'PEERS_BEHIND',
      message: 'The operator must finish the workspace policy rollout before enforcement.',
    });
};
