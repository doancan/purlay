/** Faithful one-time native provenance; a projected row is never adopted as new manual access. */
import type { Database, Selectable, Transaction } from '@purlay/db';
import { WORKSPACE_ACCESS_BATCH_MAX } from '@purlay/types/workspace-provisioning';
import type { Clock } from '../../../platform/clock';
import { managedMembership } from './authority';
import { requireWorkspaceProjectionScope, type WorkspaceProjectionScope } from './scope';

export type WorkspaceAdmissionControl = Selectable<Database['workspace_admission_controls']>;
export type WorkspaceAccessSourceRow = Selectable<Database['workspace_access_sources']>;

/** Only the first locked initialization can copy a genuine, pre-existing native row. */
export const initializeWorkspaceAdmissions = async (
  transaction: Transaction,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, WorkspaceAdmissionControl>> => {
  requireWorkspaceProjectionScope(transaction, scope);
  const ids = [...new Set(userIds)];
  if (ids.length > WORKSPACE_ACCESS_BATCH_MAX)
    throw new Error('Workspace admission initialization exceeds its bounded native batch.');
  if (ids.length === 0) return new Map();
  const existing = await transaction
    .selectFrom('workspace_admission_controls')
    .selectAll()
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', 'in', ids)
    .execute();
  const controls = new Map(existing.map((row) => [row.user_id, row]));
  const missing = ids.filter((id) => !controls.has(id));
  if (missing.length === 0) return controls;
  const native = await transaction
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select([
      'workspace_members.user_id',
      'workspace_members.role',
      'workspace_members.access_kind',
      'workspace_members.joined_at',
    ])
    .where('workspace_members.workspace_id', '=', scope.workspaceId)
    .where('workspace_members.user_id', 'in', missing)
    .where('users.deleted_at', 'is', null)
    .execute();
  const memberships = new Map(native.map((row) => [row.user_id, row]));
  const now = clock.now();
  const control = await transaction
    .insertInto('workspace_admission_controls')
    .values(
      missing.map((userId) => ({
        workspace_id: scope.workspaceId,
        user_id: userId,
        initialized_at: now,
        updated_at: now,
        last_builtin_role: memberships.get(userId)?.role ?? 'member',
        last_access_kind: memberships.get(userId)?.access_kind === 'guest' ? 'guest' : 'member',
      })),
    )
    .returningAll()
    .execute();
  for (const row of control) controls.set(row.user_id, row);
  if (native.length !== 0) {
    await transaction
      .insertInto('workspace_access_sources')
      .values(
        native.map((member) => ({
          workspace_id: scope.workspaceId,
          user_id: member.user_id,
          kind: 'manual',
          name: null,
          state: 'active',
          builtin_role: member.role,
          access_kind: member.access_kind === 'guest' ? 'guest' : 'member',
          admitted_at: member.joined_at,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute();
  }
  return controls;
};

export const initializeWorkspaceAdmission = async (
  transaction: Transaction,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userId: string,
): Promise<WorkspaceAdmissionControl> => {
  const result = (await initializeWorkspaceAdmissions(transaction, clock, scope, [userId])).get(
    userId,
  );
  if (result === undefined) throw new Error('A recorded native admission control disappeared.');
  return result;
};

/** An ordinary legacy role edit cannot add a manual source to a directory-only employee. */
export const requireManualWorkspaceSource = async (
  transaction: Transaction,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userId: string,
): Promise<WorkspaceAccessSourceRow> => {
  const control = await initializeWorkspaceAdmission(transaction, clock, scope, userId);
  if (control.blocked_at !== null) throw managedMembership();
  const source = await transaction
    .selectFrom('workspace_access_sources')
    .selectAll()
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', '=', userId)
    .where('kind', '=', 'manual')
    .where('state', '=', 'active')
    .executeTakeFirst();
  if (source === undefined) throw managedMembership();
  return source;
};
