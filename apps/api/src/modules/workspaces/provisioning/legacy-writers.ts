/** Existing native writers preserve retained provenance; they never initialize it by observing a projected row. */
import { isTransaction, type Executor, type Transaction } from '@purlay/db';
import type { UserRole } from '@purlay/types';
import type { Clock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import type { WorkspaceContext } from '../../../platform/tenancy';
import { requireManualWorkspaceSource } from './native-state';
import { lockWorkspaceProjectionScope } from './scope';
import { blockWorkspaceAdmission, revokeManualCompanyProofs } from './source-offboarding';

const nativeTransaction = (executor: Executor): Transaction => {
  if (!isTransaction(executor))
    throw new Error('A retained admission must be changed in its native transaction.');
  return executor;
};
const existingControl = async (
  executor: Executor,
  workspaceId: string,
  userId: string,
): Promise<{ readonly blocked_at: Date | null } | undefined> =>
  await executor
    .selectFrom('workspace_admission_controls')
    .select(['blocked_at'])
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .executeTakeFirst();

/** An ordinary PATCH edits an existing manual authority or refuses a directory-only employee. */
export const synchronizeLegacyManualRole = async (
  executor: Executor,
  clock: Clock,
  context: WorkspaceContext,
  userId: string,
  role: UserRole,
): Promise<void> => {
  if ((await existingControl(executor, context.workspaceId, userId)) === undefined) return;
  const tx = nativeTransaction(executor);
  const scope = await lockWorkspaceProjectionScope(tx, context.workspaceId);
  const source = await requireManualWorkspaceSource(tx, clock, scope, userId);
  if (source.builtin_role === role) return;
  await tx
    .updateTable('workspace_access_sources')
    .set({
      builtin_role: role,
      revision: crypto.randomUUID(),
      authorization_revision: crypto.randomUUID(),
      updated_at: clock.now(),
    })
    .where('id', '=', source.id)
    .where('workspace_id', '=', scope.workspaceId)
    .execute();
};

/** Old remove/leave paths cannot be undone by the next directory replay. No target SID is locked or deleted. */
export const blockLegacyWorkspaceAdmission = async (
  executor: Executor,
  clock: Clock,
  workspaceId: string,
  userId: string,
): Promise<readonly string[]> => {
  if ((await existingControl(executor, workspaceId, userId)) === undefined) return [];
  const tx = nativeTransaction(executor);
  const scope = await lockWorkspaceProjectionScope(tx, workspaceId);
  await blockWorkspaceAdmission(tx, clock, scope, userId);
  return await revokeManualCompanyProofs(tx, clock, scope, userId);
};

/** A fresh verified invitation remains explicit; a retained local block requires readmission first. */
export const requireLegacyAdmissionOpen = async (
  tx: Transaction,
  workspaceId: string,
  userId: string,
): Promise<void> => {
  const control = await existingControl(tx, workspaceId, userId);
  if (control?.blocked_at != null)
    throw new AppError({
      code: 'INVITATION_NOT_FOUND',
      message: 'That invitation does not open: it may have expired or been revoked.',
    });
};

/** Called only after an actual new native admission or explicit guest conversion, never during a read/projection. */
export const recordLegacyManualAdmission = async (
  tx: Transaction,
  clock: Clock,
  workspaceId: string,
  userId: string,
): Promise<void> => {
  if ((await existingControl(tx, workspaceId, userId)) === undefined) return;
  await requireLegacyAdmissionOpen(tx, workspaceId, userId);
  const member = await tx
    .selectFrom('workspace_members')
    .select(['role', 'access_kind', 'joined_at'])
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .executeTakeFirstOrThrow();
  const source = await tx
    .selectFrom('workspace_access_sources')
    .select(['id'])
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .where('kind', '=', 'manual')
    .where('state', '!=', 'retired')
    .executeTakeFirst();
  const values = {
    state: 'active',
    builtin_role: member.role,
    access_kind: member.access_kind,
    revision: crypto.randomUUID(),
    authorization_revision: crypto.randomUUID(),
    updated_at: clock.now(),
  };
  if (source === undefined)
    await tx
      .insertInto('workspace_access_sources')
      .values({
        ...values,
        kind: 'manual',
        workspace_id: workspaceId,
        user_id: userId,
        admitted_at: member.joined_at,
        created_at: clock.now(),
      })
      .execute();
  else
    await tx
      .updateTable('workspace_access_sources')
      .set(values)
      .where('workspace_id', '=', workspaceId)
      .where('id', '=', source.id)
      .execute();
};
