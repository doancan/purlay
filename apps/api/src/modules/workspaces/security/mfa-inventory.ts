/** Public own-factor state never exposes stored secrets or operation receipts. */
import type { Transaction } from '@purlay/db';
import type { MyWorkspaceMfa } from '@purlay/types/workspace-security';
import { workspaceAccessStatus } from './access';
import type {
  LockedWorkspaceSecurityActor,
  WorkspaceSecurityActor,
  WorkspaceSecurityDependencies,
} from './authority';
import { factorView } from './mfa-state';

/** Inventories expose state and counts, never sealed material, challenges or recovery code hashes. */
export const workspaceMfaInventory = async (
  transaction: Transaction,
  dependencies: WorkspaceSecurityDependencies,
  actor: WorkspaceSecurityActor,
  locked: LockedWorkspaceSecurityActor,
): Promise<MyWorkspaceMfa> => {
  const rows = await transaction
    .selectFrom('workspace_mfa_factors')
    .selectAll()
    .where('workspace_id', '=', locked.context.workspaceId)
    .where('user_id', '=', locked.context.userId)
    .where('state', 'in', ['pending', 'verified'])
    .orderBy('id')
    .execute();
  const factor = rows.find((row) => row.state === 'verified');
  const pending = rows.find(
    (row) =>
      row.state === 'pending' &&
      row.pending_expires_at !== null &&
      new Date(row.pending_expires_at).getTime() > dependencies.clock.now().getTime(),
  );
  const codes =
    factor === undefined
      ? undefined
      : await transaction
          .selectFrom('workspace_mfa_recovery_codes')
          .select((expression) => expression.fn.countAll<string>().as('count'))
          .where('workspace_id', '=', locked.context.workspaceId)
          .where('user_id', '=', locked.context.userId)
          .where('purpose', '=', 'factor')
          .where('factor_id', '=', factor.id)
          .where('factor_revision', '=', factor.revision)
          .where('spent_at', 'is', null)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
  const global =
    locked.session.company_workspace_id !== null || !locked.user.two_factor_enabled
      ? undefined
      : await transaction
          .selectFrom('two_factors')
          .select('id')
          .where('user_id', '=', locked.context.userId)
          .where('verified', '=', true)
          .executeTakeFirst();
  return {
    factor: factor === undefined ? null : factorView(factor),
    pending: pending === undefined ? null : factorView(pending),
    recoveryCodesRemaining: Number(codes?.count ?? 0),
    globalMfaAvailable: global !== undefined,
    status: await workspaceAccessStatus({ ...dependencies, database: transaction }, actor),
  };
};
