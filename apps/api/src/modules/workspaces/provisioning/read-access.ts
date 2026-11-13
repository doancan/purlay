/** Member/source summaries load one bounded cohort, never one query per person. */
import { sql, type Database, type Selectable, type Transaction } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import type { User } from '@purlay/types';
import {
  WORKSPACE_ACCESS_ACTIONS,
  WORKSPACE_ACCESS_BATCH_MAX,
  WORKSPACE_ACCESS_SOURCES_MAX,
  WorkspaceAccessSourceSummary,
  WorkspaceMemberAccess,
  type WorkspaceAccessPeoplePage,
  type WorkspaceAccessPeopleQuery,
} from '@purlay/types/workspace-provisioning';
import type { Clock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import { limitOf } from '../../../platform/pagination';
import { administerWorkspaceAccess } from './administration';
import {
  provisioningChanged,
  requireProvisioningReady,
  type WorkspaceProvisioningActor,
  type WorkspaceProvisioningDependencies,
} from './authority';
import { initializeWorkspaceAdmissions, type WorkspaceAccessSourceRow } from './native-state';
import { requireWorkspaceProjectionScope, type WorkspaceProjectionScope } from './scope';

type PublicUserRow = Pick<
  Selectable<Database['users']>,
  'id' | 'username' | 'display_name' | 'avatar_url'
>;

export const publicAccessUser = (row: PublicUserRow): User => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  avatarUrl: row.avatar_url,
});

export const sourceSummary = (
  row: WorkspaceAccessSourceRow,
  effective: boolean,
): WorkspaceAccessSourceSummary => {
  const result = {
    id: row.id,
    revision: row.revision,
    kind: row.kind,
    state: row.state,
    builtinRole: row.builtin_role,
    effective,
    name: row.name,
    directoryId: row.directory_id,
  };
  if (!Value.Check(WorkspaceAccessSourceSummary, result))
    throw new Error('Stored access source does not match its public contract.');
  return result;
};

export const memberAccessNotFound = (): AppError =>
  new AppError({ code: 'USER_NOT_FOUND', message: 'That person is not in this workspace.' });

/** Callers must establish current native administration and hold the scope before this loader. */
export const readWorkspaceAccessCohort = async (
  transaction: Transaction,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userIds: readonly string[],
): Promise<ReadonlyMap<string, WorkspaceMemberAccess>> => {
  requireWorkspaceProjectionScope(transaction, scope);
  const ids = [...new Set(userIds)];
  if (ids.length > WORKSPACE_ACCESS_BATCH_MAX)
    throw new Error('Access cohort exceeds its bounded page.');
  if (ids.length === 0) return new Map();
  const controls = await initializeWorkspaceAdmissions(transaction, clock, scope, ids);
  const native = await transaction
    .selectFrom('workspace_members')
    .select(['user_id', 'role', 'access_kind'])
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', 'in', ids)
    .execute();
  const members = new Map(native.map((row) => [row.user_id, row]));
  const sources = await transaction
    .selectFrom('workspace_access_sources')
    .selectAll()
    .where('workspace_id', '=', scope.workspaceId)
    .where('user_id', 'in', ids)
    .where('state', '!=', 'retired')
    .orderBy('user_id')
    .orderBy('id')
    .limit(ids.length * WORKSPACE_ACCESS_SOURCES_MAX + 1)
    .execute();
  const sourceRows = new Map<string, WorkspaceAccessSourceRow[]>();
  for (const source of sources) {
    const rows = sourceRows.get(source.user_id);
    if (rows === undefined) sourceRows.set(source.user_id, [source]);
    else rows.push(source);
  }
  const capabilities = await transaction
    .selectFrom('workspace_member_capabilities as capability')
    .innerJoin('workspace_admission_controls as control', (join) =>
      join
        .onRef('control.workspace_id', '=', 'capability.workspace_id')
        .onRef('control.user_id', '=', 'capability.user_id')
        .onRef('control.revision', '=', 'capability.projection_revision'),
    )
    .select(['capability.user_id', 'capability.capability'])
    .where('capability.workspace_id', '=', scope.workspaceId)
    .where('capability.user_id', 'in', ids)
    .where('control.blocked_at', 'is', null)
    .execute();
  const groupCounts = await sql<{ readonly user_id: string; readonly count: string }>`
    select member.user_id, count(distinct member.group_id)::text as count
    from workspace_access_group_members as member
    join workspace_access_groups as access_group on access_group.workspace_id = member.workspace_id and access_group.id = member.group_id
    join workspace_access_sources as source on source.workspace_id = member.workspace_id and source.user_id = member.user_id and source.id = member.source_id
    where member.workspace_id = ${scope.workspaceId} and member.user_id = any(${ids}::uuid[])
      and access_group.state = 'active' and source.state = 'active'
    group by member.user_id
  `.execute(transaction);
  const counts = new Map(groupCounts.rows.map((row) => [row.user_id, Number(row.count)]));
  const result = new Map<string, WorkspaceMemberAccess>();
  for (const userId of ids) {
    const control = controls.get(userId);
    if (control === undefined)
      throw new Error('A source summary lost its native admission control.');
    const member = members.get(userId);
    const currentSources = sourceRows.get(userId) ?? [];
    if (currentSources.length > WORKSPACE_ACCESS_SOURCES_MAX) throw provisioningChanged();
    const blocked = control.blocked_at !== null;
    const value = {
      userId,
      revision: control.revision,
      state: blocked ? 'offboarded' : member === undefined ? 'inactive' : 'active',
      role: member?.role ?? null,
      accessKind: member?.access_kind ?? null,
      workspaceCapabilities:
        blocked || member?.access_kind !== 'member'
          ? []
          : member.role === 'owner' || member.role === 'admin'
            ? [...WORKSPACE_ACCESS_ACTIONS]
            : capabilities.filter((row) => row.user_id === userId).map((row) => row.capability),
      sources: currentSources.map((source) =>
        sourceSummary(source, !blocked && member !== undefined && source.state === 'active'),
      ),
      groupCount: blocked ? 0 : (counts.get(userId) ?? 0),
    };
    if (!Value.Check(WorkspaceMemberAccess, value))
      throw new Error('Stored member access does not match its public contract.');
    result.set(userId, value);
  }
  return result;
};

/** An arbitrary canonical user id is not enough to materialize a workspace relationship. */
export const requireRelatedWorkspacePerson = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  userId: string,
): Promise<void> => {
  requireWorkspaceProjectionScope(transaction, scope);
  const related = await transaction
    .selectFrom('users')
    .leftJoin('workspace_members as member', (join) =>
      join
        .onRef('member.user_id', '=', 'users.id')
        .on('member.workspace_id', '=', scope.workspaceId),
    )
    .leftJoin('workspace_admission_controls as control', (join) =>
      join
        .onRef('control.user_id', '=', 'users.id')
        .on('control.workspace_id', '=', scope.workspaceId),
    )
    .select('users.id')
    .where('users.id', '=', userId)
    .where('users.deleted_at', 'is', null)
    .where((eb) =>
      eb.or([eb('member.user_id', 'is not', null), eb('control.user_id', 'is not', null)]),
    )
    .executeTakeFirst();
  if (related === undefined) throw memberAccessNotFound();
};

export const readWorkspaceMemberAccess = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  userId: string,
): Promise<WorkspaceMemberAccess> =>
  await administerWorkspaceAccess(dependencies, actor, 'read', async (transaction, scope) => {
    await requireRelatedWorkspacePerson(transaction, scope, userId);
    const existing = await transaction
      .selectFrom('workspace_admission_controls')
      .select('user_id')
      .where('workspace_id', '=', scope.workspaceId)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    if (existing === undefined) await requireProvisioningReady(dependencies);
    const result = (
      await readWorkspaceAccessCohort(transaction, dependencies.clock, scope, [userId])
    ).get(userId);
    if (result === undefined) throw memberAccessNotFound();
    return result;
  });

export const listWorkspaceAccessPeople = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  query: WorkspaceAccessPeopleQuery,
): Promise<WorkspaceAccessPeoplePage> =>
  await administerWorkspaceAccess(dependencies, actor, 'read', async (transaction, scope) => {
    const limit = limitOf(query);
    let statement = transaction
      .selectFrom('users')
      .leftJoin('workspace_members as member', (join) =>
        join
          .onRef('member.user_id', '=', 'users.id')
          .on('member.workspace_id', '=', scope.workspaceId),
      )
      .leftJoin('workspace_admission_controls as control', (join) =>
        join
          .onRef('control.user_id', '=', 'users.id')
          .on('control.workspace_id', '=', scope.workspaceId),
      )
      .select([
        'users.id',
        'users.username',
        'users.display_name',
        'users.avatar_url',
        'control.revision as access_revision',
      ])
      .where('users.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([eb('member.user_id', 'is not', null), eb('control.user_id', 'is not', null)]),
      )
      .orderBy('users.id', 'desc')
      .limit(limit + 1);
    if (query.before !== undefined) statement = statement.where('users.id', '<', query.before);
    const search = query.q?.trim();
    if (search !== undefined && search !== '')
      statement = statement.where(
        sql<boolean>`position(lower(${search} collate "C") in lower((users.display_name || ' ' || users.username) collate "C")) > 0`,
      );
    if (query.state !== undefined)
      statement = statement.where(
        sql<boolean>`case when control.blocked_at is not null then 'offboarded' when member.user_id is not null then 'active' else 'inactive' end = ${query.state}`,
      );
    const rows = await statement.execute();
    const page = rows.slice(0, limit);
    if (page.some((row) => row.access_revision === null))
      await requireProvisioningReady(dependencies);
    const cohort = await readWorkspaceAccessCohort(
      transaction,
      dependencies.clock,
      scope,
      page.map((row) => row.id),
    );
    const data = page.map((row) => {
      const access = cohort.get(row.id);
      if (access === undefined)
        throw new Error('Access page lost a member from its native cohort.');
      return { id: row.id, user: publicAccessUser(row), access };
    });
    return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
  });
