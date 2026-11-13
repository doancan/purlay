/** Bounded source-specific pickers and changes preserve each person's independent contributions. */
import { sql } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { Uuid } from '@purlay/types';
import type {
  UpdateWorkspaceGroupMembersRequest,
  WorkspaceAccessGroup,
  WorkspaceAccessGroupCandidatePage,
  WorkspaceAccessGroupCandidateQuery,
  WorkspaceAccessGroupMemberPage,
  WorkspaceAccessListQuery,
} from '@purlay/types/workspace-provisioning';
import { AppError } from '../../../platform/errors';
import { limitOf } from '../../../platform/pagination';
import { recordAudit } from '../../audit/audit';
import { administerWorkspaceAccess } from './administration';
import {
  groupNotFound,
  managedMembership,
  provisioningChanged,
  requireProvisioningReady,
  sourceNotFound,
  type WorkspaceProvisioningActor,
  type WorkspaceProvisioningDependencies,
} from './authority';
import { accessGroupCounts, lockedAccessGroup, publicAccessGroup } from './groups';
import { initializeWorkspaceAdmissions } from './native-state';
import { publicAccessUser, sourceSummary } from './read-access';
import { projectWorkspaceAccess } from './projection';
import { noteWorkspaceAccessChange } from './scope';

const ZERO = '00000000-0000-0000-0000-000000000000';
const candidatePosition = (before: string | undefined): readonly [string, string] | undefined => {
  if (before === undefined) return undefined;
  const [person, source, extra] = before.split(':');
  if (extra !== undefined || !Value.Check(Uuid, person) || !Value.Check(Uuid, source))
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Invalid candidate page.',
      details: { fields: { before: 'Use the cursor returned by the server.' } },
    });
  return [person, source];
};

export const listWorkspaceAccessGroupMembers = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  groupId: string,
  query: WorkspaceAccessListQuery,
): Promise<WorkspaceAccessGroupMemberPage> =>
  await administerWorkspaceAccess(dependencies, actor, 'read', async (transaction, scope) => {
    const group = await lockedAccessGroup(transaction, scope, groupId);
    if (group.state === 'retired') throw groupNotFound();
    const limit = limitOf(query);
    let statement = transaction
      .selectFrom('workspace_access_group_members as membership')
      .innerJoin('workspace_access_sources as source', (join) =>
        join
          .onRef('source.workspace_id', '=', 'membership.workspace_id')
          .onRef('source.user_id', '=', 'membership.user_id')
          .onRef('source.id', '=', 'membership.source_id'),
      )
      .innerJoin('users', 'users.id', 'membership.user_id')
      .leftJoin('workspace_members as native', (join) =>
        join
          .onRef('native.workspace_id', '=', 'membership.workspace_id')
          .onRef('native.user_id', '=', 'membership.user_id'),
      )
      .leftJoin('workspace_admission_controls as admission', (join) =>
        join
          .onRef('admission.workspace_id', '=', 'membership.workspace_id')
          .onRef('admission.user_id', '=', 'membership.user_id'),
      )
      .selectAll('source')
      .select([
        'membership.id as membership_id',
        'membership.created_at as membership_created_at',
        'users.username',
        'users.display_name',
        'users.avatar_url',
        'native.access_kind as native_access_kind',
        'admission.blocked_at',
      ])
      .where('membership.workspace_id', '=', scope.workspaceId)
      .where('membership.group_id', '=', groupId)
      .where('source.state', '!=', 'retired')
      .where('users.deleted_at', 'is', null)
      .orderBy('membership.id', 'desc')
      .limit(limit + 1);
    if (query.before !== undefined) statement = statement.where('membership.id', '<', query.before);
    const search = query.q?.trim();
    if (search !== undefined && search !== '')
      statement = statement.where(
        sql<boolean>`position(lower(${search} collate "C") in lower((users.display_name || ' ' || users.username) collate "C")) > 0`,
      );
    const rows = await statement.execute();
    const data = rows.slice(0, limit).map((row) => ({
      id: row.membership_id,
      userId: row.user_id,
      user: publicAccessUser({
        id: row.user_id,
        username: row.username,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
      }),
      sourceId: row.id,
      source: sourceSummary(
        row,
        group.state === 'active' &&
          row.blocked_at === null &&
          row.native_access_kind === 'member' &&
          row.state === 'active',
      ),
      joinedAt: new Date(row.membership_created_at).toISOString(),
    }));
    return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
  });

export const listWorkspaceAccessGroupCandidates = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  groupId: string,
  query: WorkspaceAccessGroupCandidateQuery,
): Promise<WorkspaceAccessGroupCandidatePage> =>
  await administerWorkspaceAccess(dependencies, actor, 'read', async (transaction, scope) => {
    const group = await lockedAccessGroup(transaction, scope, groupId);
    if (group.state === 'retired') throw groupNotFound();
    if (group.kind !== 'manual') throw managedMembership();
    const limit = limitOf(query);
    const before = candidatePosition(query.before);
    let statement = transaction
      .selectFrom('workspace_members as native')
      .innerJoin('users', 'users.id', 'native.user_id')
      .leftJoin('workspace_admission_controls as admission', (join) =>
        join
          .onRef('admission.workspace_id', '=', 'native.workspace_id')
          .onRef('admission.user_id', '=', 'native.user_id'),
      )
      .leftJoin('workspace_access_sources as source', (join) =>
        join
          .onRef('source.workspace_id', '=', 'native.workspace_id')
          .onRef('source.user_id', '=', 'native.user_id')
          .on('source.state', '=', 'active')
          .on('source.access_kind', '=', 'member'),
      )
      .select([
        'native.user_id',
        'source.id as source_id',
        'users.username',
        'users.display_name',
        'users.avatar_url',
      ])
      .where('native.workspace_id', '=', scope.workspaceId)
      .where('native.access_kind', '=', 'member')
      .where('users.deleted_at', 'is', null)
      .where('admission.blocked_at', 'is', null)
      .where((eb) => eb.or([eb('source.id', 'is not', null), eb('admission.user_id', 'is', null)]))
      .where(
        sql<boolean>`not exists (select 1 from workspace_access_group_members as existing where existing.workspace_id = ${scope.workspaceId} and existing.group_id = ${groupId} and existing.source_id = source.id)`,
      )
      .orderBy('native.user_id', 'desc')
      .orderBy(sql`coalesce(source.id, ${ZERO}::uuid)`, 'desc')
      .limit(limit + 1);
    if (before !== undefined)
      statement = statement.where(
        sql<boolean>`(native.user_id, coalesce(source.id, ${ZERO}::uuid)) < (${before[0]}::uuid, ${before[1]}::uuid)`,
      );
    const search = query.q?.trim();
    if (search !== undefined && search !== '')
      statement = statement.where(
        sql<boolean>`position(lower(${search} collate "C") in lower((users.display_name || ' ' || users.username) collate "C")) > 0`,
      );
    const rows = await statement.execute();
    const page = rows.slice(0, limit);
    if (page.length === 0) return { data: [], nextCursor: null };
    const legacy = page.filter((row) => row.source_id === null).map((row) => row.user_id);
    if (legacy.length > 0) {
      await requireProvisioningReady(dependencies);
      await initializeWorkspaceAdmissions(transaction, dependencies.clock, scope, legacy);
    }
    const explicit = page.flatMap((row) => (row.source_id === null ? [] : [row.source_id]));
    const sources = await transaction
      .selectFrom('workspace_access_sources')
      .selectAll()
      .where('workspace_id', '=', scope.workspaceId)
      .where('state', '=', 'active')
      .where('access_kind', '=', 'member')
      .where((eb) =>
        eb.or([
          ...(explicit.length === 0 ? [] : [eb('id', 'in', explicit)]),
          ...(legacy.length === 0
            ? []
            : [eb.and([eb('kind', '=', 'manual'), eb('user_id', 'in', legacy)])]),
        ]),
      )
      .execute();
    const byId = new Map(sources.map((source) => [source.id, source]));
    const manual = new Map(
      sources
        .filter((source) => source.kind === 'manual')
        .map((source) => [source.user_id, source]),
    );
    const data = page.map((row) => {
      const source = row.source_id === null ? manual.get(row.user_id) : byId.get(row.source_id);
      if (source === undefined) throw provisioningChanged();
      return {
        id: source.id,
        user: publicAccessUser({
          id: row.user_id,
          username: row.username,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
        }),
        source: sourceSummary(source, true),
      };
    });
    const last = data.at(-1);
    return {
      data,
      nextCursor:
        rows.length > limit && last !== undefined ? `${last.user.id}:${last.source.id}` : null,
    };
  });

export const updateWorkspaceAccessGroupMembers = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  groupId: string,
  input: UpdateWorkspaceGroupMembersRequest,
): Promise<WorkspaceAccessGroup> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    (input.addSourceIds?.length ?? 0) > 0 ? 'grant' : 'revoke',
    async (transaction, scope, context) => {
      const group = await lockedAccessGroup(transaction, scope, groupId);
      if (group.state === 'retired') throw groupNotFound();
      if (group.kind !== 'manual') throw managedMembership();
      if (group.revision !== input.revision) throw provisioningChanged();
      const add = [...new Set(input.addSourceIds ?? [])];
      const remove = [...new Set(input.removeSourceIds ?? [])];
      if (add.some((id) => remove.includes(id)))
        throw new AppError({
          code: 'VALIDATION_FAILED',
          message: 'A source cannot be added and removed together.',
          details: { fields: { addSourceIds: 'Use each source in one operation.' } },
        });
      const addedSources =
        add.length === 0
          ? []
          : await transaction
              .selectFrom('workspace_access_sources as source')
              .innerJoin('workspace_members as native', (join) =>
                join
                  .onRef('native.workspace_id', '=', 'source.workspace_id')
                  .onRef('native.user_id', '=', 'source.user_id'),
              )
              .innerJoin('workspace_admission_controls as admission', (join) =>
                join
                  .onRef('admission.workspace_id', '=', 'source.workspace_id')
                  .onRef('admission.user_id', '=', 'source.user_id'),
              )
              .select(['source.id', 'source.user_id'])
              .where('source.workspace_id', '=', scope.workspaceId)
              .where('source.id', 'in', add)
              .where('source.state', '=', 'active')
              .where('source.access_kind', '=', 'member')
              .where('native.access_kind', '=', 'member')
              .where('admission.blocked_at', 'is', null)
              .execute();
      if (addedSources.length !== add.length) throw sourceNotFound();
      const existing =
        remove.length === 0
          ? []
          : await transaction
              .selectFrom('workspace_access_group_members')
              .select(['source_id', 'user_id'])
              .where('workspace_id', '=', scope.workspaceId)
              .where('group_id', '=', groupId)
              .where('source_id', 'in', remove)
              .execute();
      if (existing.length !== remove.length) throw sourceNotFound();
      if (remove.length > 0)
        await transaction
          .deleteFrom('workspace_access_group_members')
          .where('workspace_id', '=', scope.workspaceId)
          .where('group_id', '=', groupId)
          .where('source_id', 'in', remove)
          .execute();
      const now = dependencies.clock.now();
      const inserted =
        addedSources.length === 0
          ? []
          : await transaction
              .insertInto('workspace_access_group_members')
              .values(
                addedSources.map((source) => ({
                  workspace_id: scope.workspaceId,
                  group_id: groupId,
                  user_id: source.user_id,
                  source_id: source.id,
                  created_at: now,
                })),
              )
              .onConflict((conflict) =>
                conflict.columns(['workspace_id', 'group_id', 'user_id', 'source_id']).doNothing(),
              )
              .returning('user_id')
              .execute();
      let current = group;
      if (inserted.length > 0 || existing.length > 0) {
        current = await transaction
          .updateTable('workspace_access_groups')
          .set({ revision: crypto.randomUUID(), updated_at: now })
          .where('workspace_id', '=', scope.workspaceId)
          .where('id', '=', groupId)
          .returningAll()
          .executeTakeFirstOrThrow();
        const users = [
          ...new Set([
            ...inserted.map((row) => row.user_id),
            ...existing.map((row) => row.user_id),
          ]),
        ];
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
          action: 'workspace.access.group_members_changed',
          targetType: 'workspace',
          targetId: scope.workspaceId,
          metadata: {
            groupId,
            addedSources: String(inserted.length),
            removedSources: String(existing.length),
          },
        });
      }
      return publicAccessGroup(
        current,
        (await accessGroupCounts(transaction, scope, [groupId])).get(groupId) ?? 0,
      );
    },
  );
