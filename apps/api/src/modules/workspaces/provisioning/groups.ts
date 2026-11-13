/** Access groups retain exact admission-source membership and never become sidebar folders. */
import { sql, type Database, type Selectable, type Transaction } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { Uuid } from '@purlay/types';
import {
  WorkspaceAccessGroup,
  type CreateWorkspaceAccessGroupRequest,
  type ProvisioningRevisionRequest,
  type UpdateWorkspaceAccessGroupRequest,
  type WorkspaceAccessGroupPage,
  type WorkspaceAccessListQuery,
} from '@purlay/types/workspace-provisioning';
import { AppError } from '../../../platform/errors';
import { limitOf } from '../../../platform/pagination';
import { recordAudit } from '../../audit/audit';
import { administerWorkspaceAccess } from './administration';
import {
  groupNotFound,
  managedMembership,
  provisioningChanged,
  type WorkspaceProvisioningActor,
  type WorkspaceProvisioningDependencies,
} from './authority';
import { normalizedAccessName } from './roles';
import { projectWorkspaceAccess } from './projection';
import {
  noteWorkspaceAccessChange,
  requireWorkspaceProjectionScope,
  type WorkspaceProjectionScope,
} from './scope';

export type WorkspaceAccessGroupRow = Selectable<Database['workspace_access_groups']>;

export const publicAccessGroup = (
  row: WorkspaceAccessGroupRow,
  memberCount: number,
): WorkspaceAccessGroup => {
  const result = {
    id: row.id,
    revision: row.revision,
    name: row.name,
    kind: row.kind,
    directoryId: row.directory_id,
    memberCount,
    retiredAt: row.retired_at === null ? null : new Date(row.retired_at).toISOString(),
  };
  if (!Value.Check(WorkspaceAccessGroup, result))
    throw new Error('Stored access group does not match its public contract.');
  return result;
};

export const lockedAccessGroup = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  groupId: string,
): Promise<WorkspaceAccessGroupRow> => {
  requireWorkspaceProjectionScope(transaction, scope);
  if (!Value.Check(Uuid, groupId)) throw groupNotFound();
  const row = await transaction
    .selectFrom('workspace_access_groups')
    .selectAll()
    .where('workspace_id', '=', scope.workspaceId)
    .where('id', '=', groupId)
    .executeTakeFirst();
  if (row === undefined) throw groupNotFound();
  return row;
};

export const accessGroupCounts = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  groupIds: readonly string[],
): Promise<ReadonlyMap<string, number>> => {
  requireWorkspaceProjectionScope(transaction, scope);
  if (groupIds.length === 0) return new Map();
  const rows = await sql<{ readonly group_id: string; readonly count: string }>`
    select member.group_id, count(distinct member.user_id)::text as count
    from workspace_access_group_members as member
    join workspace_access_sources as source on source.workspace_id = member.workspace_id
      and source.id = member.source_id and source.user_id = member.user_id
    join users on users.id = member.user_id and users.deleted_at is null
    where member.workspace_id = ${scope.workspaceId} and member.group_id = any(${groupIds}::uuid[])
      and source.state <> 'retired'
    group by member.group_id
  `.execute(transaction);
  return new Map(rows.rows.map((row) => [row.group_id, Number(row.count)]));
};

export const accessGroupUsers = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  groupId: string,
): Promise<readonly string[]> => {
  requireWorkspaceProjectionScope(transaction, scope);
  return (
    await transaction
      .selectFrom('workspace_access_group_members')
      .select('user_id')
      .distinct()
      .where('workspace_id', '=', scope.workspaceId)
      .where('group_id', '=', groupId)
      .execute()
  ).map((row) => row.user_id);
};

const availableName = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  name: string,
  except?: string,
): Promise<void> => {
  let query = transaction
    .selectFrom('workspace_access_groups')
    .select('id')
    .where('workspace_id', '=', scope.workspaceId)
    .where('kind', '=', 'manual')
    .where('state', '!=', 'retired')
    .where(sql<boolean>`name_key = lower(${name} collate "C")`);
  if (except !== undefined) query = query.where('id', '!=', except);
  if ((await query.executeTakeFirst()) !== undefined)
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Choose another access group name.',
      details: { fields: { name: 'A current manual group already has that name.' } },
    });
};

export const listWorkspaceAccessGroups = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  query: WorkspaceAccessListQuery,
): Promise<WorkspaceAccessGroupPage> =>
  await administerWorkspaceAccess(dependencies, actor, 'read', async (transaction, scope) => {
    const limit = limitOf(query);
    let statement = transaction
      .selectFrom('workspace_access_groups')
      .selectAll()
      .where('workspace_id', '=', scope.workspaceId)
      .where('state', '!=', 'retired')
      .orderBy('id', 'desc')
      .limit(limit + 1);
    if (query.before !== undefined) statement = statement.where('id', '<', query.before);
    const search = query.q?.trim();
    if (search !== undefined && search !== '')
      statement = statement.where(
        sql<boolean>`position(lower(${search} collate "C") in name_key) > 0`,
      );
    const rows = await statement.execute();
    const page = rows.slice(0, limit);
    const counts = await accessGroupCounts(
      transaction,
      scope,
      page.map((row) => row.id),
    );
    const data = page.map((row) => publicAccessGroup(row, counts.get(row.id) ?? 0));
    return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
  });

export const createWorkspaceAccessGroup = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  input: CreateWorkspaceAccessGroupRequest,
): Promise<WorkspaceAccessGroup> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'grant',
    async (transaction, scope, context) => {
      const name = normalizedAccessName(input.name);
      await availableName(transaction, scope, name);
      const now = dependencies.clock.now();
      const row = await transaction
        .insertInto('workspace_access_groups')
        .values({
          workspace_id: scope.workspaceId,
          kind: 'manual',
          name,
          state: 'active',
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      noteWorkspaceAccessChange(transaction, scope);
      await recordAudit(transaction, dependencies.clock, {
        workspaceId: scope.workspaceId,
        actorUserId: context.userId,
        action: 'workspace.access.group_created',
        targetType: 'workspace',
        targetId: scope.workspaceId,
        metadata: { groupId: row.id },
      });
      return publicAccessGroup(row, 0);
    },
  );

export const updateWorkspaceAccessGroup = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  groupId: string,
  input: UpdateWorkspaceAccessGroupRequest,
): Promise<WorkspaceAccessGroup> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'grant',
    async (transaction, scope, context) => {
      let row = await lockedAccessGroup(transaction, scope, groupId);
      if (row.state === 'retired') throw groupNotFound();
      if (row.kind !== 'manual') throw managedMembership();
      if (row.revision !== input.revision) throw provisioningChanged();
      const name = normalizedAccessName(input.name);
      if (name !== row.name) {
        await availableName(transaction, scope, name, groupId);
        row = await transaction
          .updateTable('workspace_access_groups')
          .set({ name, revision: crypto.randomUUID(), updated_at: dependencies.clock.now() })
          .where('workspace_id', '=', scope.workspaceId)
          .where('id', '=', groupId)
          .returningAll()
          .executeTakeFirstOrThrow();
        noteWorkspaceAccessChange(transaction, scope);
        await recordAudit(transaction, dependencies.clock, {
          workspaceId: scope.workspaceId,
          actorUserId: context.userId,
          action: 'workspace.access.group_updated',
          targetType: 'workspace',
          targetId: scope.workspaceId,
          metadata: { groupId, revision: row.revision },
        });
      }
      return publicAccessGroup(
        row,
        (await accessGroupCounts(transaction, scope, [groupId])).get(groupId) ?? 0,
      );
    },
  );

export const retireWorkspaceAccessGroup = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  groupId: string,
  input: ProvisioningRevisionRequest,
): Promise<void> => {
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'revoke',
    async (transaction, scope, context) => {
      const row = await lockedAccessGroup(transaction, scope, groupId);
      if (row.state === 'retired') return;
      if (row.kind !== 'manual') throw managedMembership();
      if (row.revision !== input.revision) throw provisioningChanged();
      const users = await accessGroupUsers(transaction, scope, groupId);
      const now = dependencies.clock.now();
      await transaction
        .updateTable('workspace_access_groups')
        .set({ state: 'retired', retired_at: now, revision: crypto.randomUUID(), updated_at: now })
        .where('workspace_id', '=', scope.workspaceId)
        .where('id', '=', groupId)
        .execute();
      await transaction
        .deleteFrom('workspace_access_role_grants')
        .where('workspace_id', '=', scope.workspaceId)
        .where('group_id', '=', groupId)
        .execute();
      await transaction
        .deleteFrom('workspace_access_group_members')
        .where('workspace_id', '=', scope.workspaceId)
        .where('group_id', '=', groupId)
        .execute();
      noteWorkspaceAccessChange(transaction, scope, users);
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
        action: 'workspace.access.group_retired',
        targetType: 'workspace',
        targetId: scope.workspaceId,
        metadata: { groupId, affectedPeople: String(users.length) },
      });
    },
  );
};
