/** Source changes and native effective authority commit together, in bounded set-wise batches. */
import { sql, type Database, type Selectable, type Transaction } from '@purlay/db';
import type { UserRole } from '@purlay/types';
import {
  WORKSPACE_ACCESS_ACTIONS,
  WORKSPACE_ACCESS_BATCH_MAX,
  type WorkspaceAccessAction,
} from '@purlay/types/workspace-provisioning';
import type { Clock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import type { WorkspaceChannels } from '../channels-port';
import { provisioningChanged, provisioningNotReady } from './authority';
import { initializeWorkspaceAdmissions } from './native-state';
import {
  noteWorkspaceAccessChange,
  requireWorkspaceProjectionScope,
  type WorkspaceProjectionScope,
} from './scope';

type NativeMember = Selectable<Database['workspace_members']> & {
  readonly deleted_at: Date | null;
};
type Source = Selectable<Database['workspace_access_sources']>;

const highestRole = (sources: readonly Source[]): UserRole =>
  sources.some((source) => source.builtin_role === 'owner')
    ? 'owner'
    : sources.some((source) => source.builtin_role === 'admin')
      ? 'admin'
      : 'member';

const projectBatch = async (
  transaction: Transaction,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userIds: readonly string[],
  channels: WorkspaceChannels,
): Promise<readonly string[]> => {
  if (channels.access === undefined) throw provisioningNotReady();
  const controls = await initializeWorkspaceAdmissions(transaction, clock, scope, userIds);
  const native: readonly NativeMember[] = await transaction
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .selectAll('workspace_members')
    .select('users.deleted_at')
    .where('workspace_members.workspace_id', '=', scope.workspaceId)
    .where('workspace_members.user_id', 'in', userIds)
    .execute();
  const memberships = new Map(native.map((member) => [member.user_id, member]));
  const sources = await transaction
    .selectFrom('workspace_access_sources')
    .selectAll()
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', 'in', userIds)
    .where('state', '=', 'active')
    .execute();
  const byUser = new Map<string, Source[]>();
  for (const source of sources) {
    const held = byUser.get(source.user_id);
    if (held === undefined) byUser.set(source.user_id, [source]);
    else held.push(source);
  }
  const removed: string[] = [];
  const desired = new Map<string, UserRole>();
  for (const userId of userIds) {
    const member = memberships.get(userId);
    // Account erasure deliberately retains anonymised native membership tombstones.
    if (member?.deleted_at != null) continue;
    const active = controls.get(userId)?.blocked_at === null ? (byUser.get(userId) ?? []) : [];
    if (active.length === 0) {
      removed.push(userId);
      continue;
    }
    if (member === undefined && active.every((source) => source.access_kind === 'guest'))
      throw provisioningChanged(); // A fresh, validated guest invitation must establish its scope/history.
    desired.set(userId, highestRole(active));
  }
  const owners = await transaction
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select('workspace_members.user_id')
    .where('workspace_members.workspace_id', '=', scope.workspaceId)
    .where('workspace_members.role', '=', 'owner')
    .where('users.deleted_at', 'is', null)
    .execute();
  const remainingOwners = new Set(owners.map((owner) => owner.user_id));
  for (const userId of userIds) {
    if (desired.get(userId) === 'owner') remainingOwners.add(userId);
    else if (memberships.get(userId)?.deleted_at == null) remainingOwners.delete(userId);
  }
  if (owners.length !== 0 && remainingOwners.size === 0)
    throw new AppError({
      code: 'LAST_OWNER',
      message: 'A workspace keeps at least one owner: make somebody else an owner first.',
    });

  const now = clock.now();
  const updates = userIds.map((userId) => {
    const control = controls.get(userId);
    if (control === undefined) throw new Error('Workspace projection lost its admission control.');
    const member = memberships.get(userId);
    return {
      user_id: userId,
      revision: crypto.randomUUID(),
      last_builtin_role: desired.get(userId) ?? member?.role ?? control.last_builtin_role,
      last_access_kind: member?.access_kind ?? control.last_access_kind,
    };
  });
  await sql`
    update workspace_admission_controls as control
    set revision = projected.revision, last_builtin_role = projected.last_builtin_role::user_role,
      last_access_kind = projected.last_access_kind, updated_at = ${now}
    from jsonb_to_recordset(${JSON.stringify(updates)}::jsonb)
      as projected(user_id uuid, revision uuid, last_builtin_role text, last_access_kind text)
    where control.workspace_id = ${scope.workspaceId} and control.user_id = projected.user_id
  `.execute(transaction);
  const admitted = [...desired].map(([userId, role]) => {
    const member = memberships.get(userId);
    const admission = byUser.get(userId)?.reduce<Date | undefined>((earliest, source) => {
      const at = new Date(source.admitted_at);
      return earliest === undefined || at < earliest ? at : earliest;
    }, undefined);
    if (admission === undefined) throw new Error('Native admission requires an active source.');
    return {
      workspace_id: scope.workspaceId,
      user_id: userId,
      role,
      joined_at: member?.joined_at ?? admission,
      access_kind: member?.access_kind === 'guest' ? 'guest' : 'member',
      guest_since: member?.guest_since ?? null,
      guest_expires_at: member?.guest_expires_at ?? null,
      guest_modules: member?.guest_modules ?? null,
    };
  });
  if (admitted.length !== 0)
    await transaction
      .insertInto('workspace_members')
      .values(admitted)
      .onConflict((conflict) =>
        conflict
          .columns(['workspace_id', 'user_id'])
          .doUpdateSet((eb) => ({ role: eb.ref('excluded.role') })),
      )
      .execute();
  const channelIds = await channels.access.project(transaction, clock, scope, userIds);
  if (removed.length !== 0)
    await transaction
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', scope.workspaceId)
      .where('user_id', 'in', removed)
      .execute();

  const capabilities = await sql<{
    readonly user_id: string;
    readonly capability: WorkspaceAccessAction;
  }>`
    with contributed as (
      select source.user_id, unnest(role.capabilities) as capability
      from workspace_access_role_grants as role_grant
      join workspace_access_roles as role on role.workspace_id = role_grant.workspace_id and role.id = role_grant.role_id
      join workspace_access_sources as source on source.workspace_id = role_grant.workspace_id and source.id = role_grant.source_id
      where role_grant.workspace_id = ${scope.workspaceId} and source.user_id = any(${userIds}::uuid[])
        and source.state = 'active' and source.access_kind = 'member' and role.retired_at is null
      union
      select source.user_id, unnest(role.capabilities) as capability
      from workspace_access_role_grants as role_grant
      join workspace_access_roles as role on role.workspace_id = role_grant.workspace_id and role.id = role_grant.role_id
      join workspace_access_groups as access_group on access_group.workspace_id = role_grant.workspace_id and access_group.id = role_grant.group_id
      join workspace_access_group_members as member on member.workspace_id = access_group.workspace_id and member.group_id = access_group.id
      join workspace_access_sources as source on source.workspace_id = member.workspace_id and source.user_id = member.user_id and source.id = member.source_id
      where role_grant.workspace_id = ${scope.workspaceId} and source.user_id = any(${userIds}::uuid[])
        and access_group.state = 'active' and source.state = 'active'
        and source.access_kind = 'member' and role.retired_at is null
    )
    select distinct contributed.user_id, contributed.capability
    from contributed
    join workspace_admission_controls as control on control.workspace_id = ${scope.workspaceId} and control.user_id = contributed.user_id
    join workspace_members as native on native.workspace_id = control.workspace_id and native.user_id = control.user_id
    where control.blocked_at is null and native.access_kind = 'member'
      and contributed.capability = any(${WORKSPACE_ACCESS_ACTIONS}::text[])
  `.execute(transaction);
  await transaction
    .deleteFrom('workspace_member_capabilities')
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', 'in', userIds)
    .execute();
  const revisions = new Map(updates.map((update) => [update.user_id, update.revision]));
  if (capabilities.rows.length !== 0)
    await transaction
      .insertInto('workspace_member_capabilities')
      .values(
        capabilities.rows.map((row) => {
          const revision = revisions.get(row.user_id);
          if (revision === undefined)
            throw new Error('Scoped capability has no native projection revision.');
          return {
            workspace_id: scope.workspaceId,
            user_id: row.user_id,
            capability: row.capability,
            projection_revision: revision,
          };
        }),
      )
      .execute();
  return channelIds;
};

export const projectWorkspaceAccess = async (
  transaction: Transaction,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userIds: readonly string[],
  channels: WorkspaceChannels,
): Promise<readonly string[]> => {
  requireWorkspaceProjectionScope(transaction, scope);
  const ids = [...new Set(userIds)].sort();
  if (ids.length !== 0) noteWorkspaceAccessChange(transaction, scope, ids);
  const changedChannels = new Set<string>();
  for (let start = 0; start < ids.length; start += WORKSPACE_ACCESS_BATCH_MAX) {
    for (const id of await projectBatch(
      transaction,
      clock,
      scope,
      ids.slice(start, start + WORKSPACE_ACCESS_BATCH_MAX),
      channels,
    ))
      changedChannels.add(id);
  }
  return [...changedChannels].sort();
};
