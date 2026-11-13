/** The native SCIM resource ID selects a directory group; provider names never select a role. */
import type { Transaction } from '@purlay/db';
import type { Clock } from '../../../platform/clock';
import { recordAudit } from '../../audit/audit';
import type { WorkspaceChannels } from '../channels-port';
import { groupNotFound, sourceNotFound } from './authority';
import { accessGroupUsers } from './groups';
import { normalizedAccessName } from './roles';
import { projectWorkspaceAccess } from './projection';
import {
  noteWorkspaceAccessChange,
  requireWorkspaceProjectionScope,
  type WorkspaceProjectionScope,
} from './scope';

interface DirectoryGroupDependencies {
  readonly clock: Clock;
  readonly channels: WorkspaceChannels;
}

export const reconcileDirectoryAccessGroup = async (
  transaction: Transaction,
  dependencies: DirectoryGroupDependencies,
  scope: WorkspaceProjectionScope,
  input: {
    readonly directoryId: string;
    readonly directoryGroupReference: string;
    readonly name: string;
    readonly sourceIds: readonly string[];
    readonly active: boolean;
  },
): Promise<{ readonly groupId: string; readonly affectedUserIds: readonly string[] }> => {
  requireWorkspaceProjectionScope(transaction, scope);
  const name = normalizedAccessName(input.name);
  const sourceIds = [...new Set(input.sourceIds)].sort();
  const sources =
    sourceIds.length === 0
      ? []
      : await transaction
          .selectFrom('workspace_access_sources')
          .select(['id', 'user_id'])
          .where('workspace_id', '=', scope.workspaceId)
          .where('directory_id', '=', input.directoryId)
          .where('kind', '=', 'directory')
          .where('state', '!=', 'retired')
          .where('access_kind', '=', 'member')
          .where('id', 'in', sourceIds)
          .execute();
  if (sources.length !== sourceIds.length) throw sourceNotFound();
  let group = await transaction
    .selectFrom('workspace_access_groups')
    .selectAll()
    .where('workspace_id', '=', scope.workspaceId)
    .where('directory_id', '=', input.directoryId)
    .where('kind', '=', 'directory')
    .where('directory_group_reference', '=', input.directoryGroupReference)
    .executeTakeFirst();
  if (group?.state === 'retired') throw groupNotFound();
  const created = group === undefined;
  const now = dependencies.clock.now();
  const state = input.active ? 'active' : 'inactive';
  group ??= await transaction
    .insertInto('workspace_access_groups')
    .values({
      workspace_id: scope.workspaceId,
      kind: 'directory',
      directory_id: input.directoryId,
      directory_group_reference: input.directoryGroupReference,
      name,
      state,
      created_at: now,
      updated_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const oldMembers = await transaction
    .selectFrom('workspace_access_group_members')
    .select(['source_id', 'user_id'])
    .where('workspace_id', '=', scope.workspaceId)
    .where('group_id', '=', group.id)
    .execute();
  const oldSources = new Set(oldMembers.map((member) => member.source_id));
  const sameMembers =
    oldSources.size === sourceIds.length && sourceIds.every((id) => oldSources.has(id));
  const stateChanged = group.state !== state;
  const metadataChanged = created || stateChanged || group.name !== name;
  if (!metadataChanged && sameMembers) return { groupId: group.id, affectedUserIds: [] };
  if (!created)
    group = await transaction
      .updateTable('workspace_access_groups')
      .set({ name, state, revision: crypto.randomUUID(), updated_at: now })
      .where('workspace_id', '=', scope.workspaceId)
      .where('id', '=', group.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  const desired = new Set(sourceIds);
  const removedSources = oldMembers.filter((member) => !desired.has(member.source_id));
  if (removedSources.length > 0)
    await transaction
      .deleteFrom('workspace_access_group_members')
      .where('workspace_id', '=', scope.workspaceId)
      .where('group_id', '=', group.id)
      .where(
        'source_id',
        'in',
        removedSources.map((member) => member.source_id),
      )
      .execute();
  const addedSources = sources.filter((source) => !oldSources.has(source.id));
  if (addedSources.length > 0)
    await transaction
      .insertInto('workspace_access_group_members')
      .values(
        addedSources.map((source) => ({
          workspace_id: scope.workspaceId,
          group_id: group.id,
          user_id: source.user_id,
          source_id: source.id,
          created_at: now,
        })),
      )
      .execute();
  const affected = [
    ...new Set(
      stateChanged
        ? [
            ...oldMembers.map((member) => member.user_id),
            ...sources.map((source) => source.user_id),
          ]
        : [
            ...removedSources.map((member) => member.user_id),
            ...addedSources.map((source) => source.user_id),
          ],
    ),
  ].sort();
  noteWorkspaceAccessChange(transaction, scope, affected);
  await projectWorkspaceAccess(
    transaction,
    dependencies.clock,
    scope,
    affected,
    dependencies.channels,
  );
  await recordAudit(transaction, dependencies.clock, {
    workspaceId: scope.workspaceId,
    actorUserId: null,
    action: created ? 'workspace.access.group_created' : 'workspace.access.group_updated',
    targetType: 'workspace',
    targetId: scope.workspaceId,
    metadata: {
      directoryId: input.directoryId,
      groupId: group.id,
      affectedPeople: String(affected.length),
    },
  });
  return { groupId: group.id, affectedUserIds: affected };
};

export const retireDirectoryAccessGroup = async (
  transaction: Transaction,
  dependencies: DirectoryGroupDependencies,
  scope: WorkspaceProjectionScope,
  input: { readonly directoryId: string; readonly directoryGroupReference: string },
): Promise<readonly string[]> => {
  requireWorkspaceProjectionScope(transaction, scope);
  const group = await transaction
    .selectFrom('workspace_access_groups')
    .selectAll()
    .where('workspace_id', '=', scope.workspaceId)
    .where('directory_id', '=', input.directoryId)
    .where('directory_group_reference', '=', input.directoryGroupReference)
    .where('kind', '=', 'directory')
    .where('state', '!=', 'retired')
    .executeTakeFirst();
  if (group === undefined) return [];
  const users = await accessGroupUsers(transaction, scope, group.id);
  const now = dependencies.clock.now();
  await transaction
    .updateTable('workspace_access_groups')
    .set({ state: 'retired', retired_at: now, revision: crypto.randomUUID(), updated_at: now })
    .where('workspace_id', '=', scope.workspaceId)
    .where('id', '=', group.id)
    .execute();
  await transaction
    .deleteFrom('workspace_access_role_grants')
    .where('workspace_id', '=', scope.workspaceId)
    .where('group_id', '=', group.id)
    .execute();
  await transaction
    .deleteFrom('workspace_access_group_members')
    .where('workspace_id', '=', scope.workspaceId)
    .where('group_id', '=', group.id)
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
    actorUserId: null,
    action: 'workspace.access.group_retired',
    targetType: 'workspace',
    targetId: scope.workspaceId,
    metadata: {
      directoryId: input.directoryId,
      groupId: group.id,
      affectedPeople: String(users.length),
    },
  });
  return users;
};
