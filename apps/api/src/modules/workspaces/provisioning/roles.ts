/** Named finite actions project into native capabilities; they never become builtin roles. */
import { sql, type Database, type Selectable, type Transaction } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { Uuid } from '@purlay/types';
import {
  WORKSPACE_ACCESS_NAME_MAX,
  WorkspaceAccessRole,
  type CreateWorkspaceAccessRoleRequest,
  type ProvisioningRevisionRequest,
  type UpdateWorkspaceAccessRoleRequest,
  type WorkspaceAccessListQuery,
  type WorkspaceAccessRolePage,
} from '@purlay/types/workspace-provisioning';
import { AppError } from '../../../platform/errors';
import { limitOf } from '../../../platform/pagination';
import { recordAudit } from '../../audit/audit';
import { administerWorkspaceAccess } from './administration';
import {
  provisioningChanged,
  roleNotFound,
  type WorkspaceProvisioningActor,
  type WorkspaceProvisioningDependencies,
} from './authority';
import { projectWorkspaceAccess } from './projection';
import {
  noteWorkspaceAccessChange,
  requireWorkspaceProjectionScope,
  type WorkspaceProjectionScope,
} from './scope';

export type WorkspaceRoleRow = Selectable<Database['workspace_access_roles']>;

export const normalizedAccessName = (name: string): string => {
  const value = name.trim().normalize('NFC');
  if (value.length === 0 || value.length > WORKSPACE_ACCESS_NAME_MAX)
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Name the access definition.',
      details: { fields: { name: 'Use a name of at most 64 characters.' } },
    });
  return value;
};

export const publicAccessRole = (row: WorkspaceRoleRow): WorkspaceAccessRole => {
  const result = {
    id: row.id,
    revision: row.revision,
    name: row.name,
    capabilities: row.capabilities,
    retiredAt: row.retired_at === null ? null : new Date(row.retired_at).toISOString(),
  };
  if (!Value.Check(WorkspaceAccessRole, result))
    throw new Error('Stored access role does not match its contract.');
  return result;
};

export const lockedAccessRole = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  id: string,
): Promise<WorkspaceRoleRow> => {
  requireWorkspaceProjectionScope(transaction, scope);
  if (!Value.Check(Uuid, id)) throw roleNotFound();
  const role = await transaction
    .selectFrom('workspace_access_roles')
    .selectAll()
    .where('workspace_id', '=', scope.workspaceId)
    .where('id', '=', id)
    .executeTakeFirst();
  if (role === undefined) throw roleNotFound();
  return role;
};

const availableRoleName = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  name: string,
  except?: string,
): Promise<void> => {
  let statement = transaction
    .selectFrom('workspace_access_roles')
    .select('id')
    .where('workspace_id', '=', scope.workspaceId)
    .where('retired_at', 'is', null)
    .where(sql<boolean>`name_key = lower(${name} collate "C")`);
  if (except !== undefined) statement = statement.where('id', '!=', except);
  if ((await statement.executeTakeFirst()) !== undefined)
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Choose another role name.',
      details: { fields: { name: 'A current role already has that name.' } },
    });
};

const roleUsers = async (
  transaction: Transaction,
  dependencies: WorkspaceProvisioningDependencies,
  scope: WorkspaceProjectionScope,
  roleId: string,
): Promise<readonly string[]> => {
  const core = await sql<{ readonly user_id: string }>`
    select source.user_id
    from workspace_access_role_grants as role_grant
    join workspace_access_sources as source on source.workspace_id = role_grant.workspace_id and source.id = role_grant.source_id
    where role_grant.workspace_id = ${scope.workspaceId} and role_grant.role_id = ${roleId}
    union
    select member.user_id
    from workspace_access_role_grants as role_grant
    join workspace_access_group_members as member on member.workspace_id = role_grant.workspace_id and member.group_id = role_grant.group_id
    where role_grant.workspace_id = ${scope.workspaceId} and role_grant.role_id = ${roleId}
  `.execute(transaction);
  const chat =
    (await dependencies.channels.access?.roleUsers(transaction, scope.workspaceId, roleId)) ?? [];
  return [...new Set([...core.rows.map((row) => row.user_id), ...chat])].sort();
};

export const listWorkspaceAccessRoles = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  query: WorkspaceAccessListQuery,
): Promise<WorkspaceAccessRolePage> =>
  await administerWorkspaceAccess(dependencies, actor, 'read', async (transaction, scope) => {
    const limit = limitOf(query);
    let statement = transaction
      .selectFrom('workspace_access_roles')
      .selectAll()
      .where('workspace_id', '=', scope.workspaceId)
      .where('retired_at', 'is', null)
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (query.before !== undefined) statement = statement.where('id', '<', query.before);
    const search = query.q?.trim();
    if (search !== undefined && search !== '')
      statement = statement.where(
        sql<boolean>`position(lower(${search} collate "C") in name_key) > 0`,
      );
    const rows = await statement.execute();
    const data = rows.slice(0, limit).map(publicAccessRole);
    return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
  });

export const createWorkspaceAccessRole = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  input: CreateWorkspaceAccessRoleRequest,
): Promise<WorkspaceAccessRole> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'grant',
    async (transaction, scope, context) => {
      const name = normalizedAccessName(input.name);
      await availableRoleName(transaction, scope, name);
      const now = dependencies.clock.now();
      const role = await transaction
        .insertInto('workspace_access_roles')
        .values({
          workspace_id: scope.workspaceId,
          name,
          capabilities: [...input.capabilities],
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      noteWorkspaceAccessChange(transaction, scope);
      await recordAudit(transaction, dependencies.clock, {
        workspaceId: scope.workspaceId,
        actorUserId: context.userId,
        action: 'workspace.access.role_created',
        targetType: 'workspace',
        targetId: scope.workspaceId,
        metadata: { roleId: role.id, capabilityCount: String(role.capabilities.length) },
      });
      return publicAccessRole(role);
    },
  );

export const updateWorkspaceAccessRole = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  roleId: string,
  input: UpdateWorkspaceAccessRoleRequest,
): Promise<WorkspaceAccessRole> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'grant',
    async (transaction, scope, context) => {
      const role = await lockedAccessRole(transaction, scope, roleId);
      if (role.retired_at !== null) throw roleNotFound();
      if (role.revision !== input.revision) throw provisioningChanged();
      const name = input.name === undefined ? role.name : normalizedAccessName(input.name);
      const capabilities =
        input.capabilities === undefined ? role.capabilities : [...input.capabilities];
      if (
        name === role.name &&
        [...capabilities].sort().join(',') === [...role.capabilities].sort().join(',')
      )
        return publicAccessRole(role);
      await availableRoleName(transaction, scope, name, roleId);
      const users = await roleUsers(transaction, dependencies, scope, roleId);
      const updated = await transaction
        .updateTable('workspace_access_roles')
        .set({
          name,
          capabilities,
          revision: crypto.randomUUID(),
          updated_at: dependencies.clock.now(),
        })
        .where('workspace_id', '=', scope.workspaceId)
        .where('id', '=', roleId)
        .returningAll()
        .executeTakeFirstOrThrow();
      noteWorkspaceAccessChange(transaction, scope);
      await projectWorkspaceAccess(
        transaction,
        dependencies.clock,
        scope,
        users,
        dependencies.channels,
      );
      await recordAudit(transaction, dependencies.clock, {
        workspaceId: scope.workspaceId,
        actorUserId: context.userId,
        action: 'workspace.access.role_updated',
        targetType: 'workspace',
        targetId: scope.workspaceId,
        metadata: { roleId, revision: updated.revision, affectedPeople: String(users.length) },
      });
      return publicAccessRole(updated);
    },
  );

export const retireWorkspaceAccessRole = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  roleId: string,
  input: ProvisioningRevisionRequest,
): Promise<void> => {
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'revoke',
    async (transaction, scope, context) => {
      const role = await lockedAccessRole(transaction, scope, roleId);
      if (role.retired_at !== null) return;
      if (role.revision !== input.revision) throw provisioningChanged();
      const users = await roleUsers(transaction, dependencies, scope, roleId);
      const now = dependencies.clock.now();
      await transaction
        .updateTable('workspace_access_roles')
        .set({ retired_at: now, revision: crypto.randomUUID(), updated_at: now })
        .where('workspace_id', '=', scope.workspaceId)
        .where('id', '=', roleId)
        .execute();
      noteWorkspaceAccessChange(transaction, scope);
      await transaction
        .deleteFrom('workspace_access_role_grants')
        .where('workspace_id', '=', scope.workspaceId)
        .where('role_id', '=', roleId)
        .execute();
      await projectWorkspaceAccess(
        transaction,
        dependencies.clock,
        scope,
        users,
        dependencies.channels,
      );
      await recordAudit(transaction, dependencies.clock, {
        workspaceId: scope.workspaceId,
        actorUserId: context.userId,
        action: 'workspace.access.role_retired',
        targetType: 'workspace',
        targetId: scope.workspaceId,
        metadata: { roleId, affectedPeople: String(users.length) },
      });
    },
  );
};
