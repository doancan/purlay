/** Role grants contribute compatible actions only; admission and conversation visibility stay native. */
import { sql, type Database, type Selectable, type Transaction } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { Uuid } from '@purlay/types';
import {
  CHANNEL_ACCESS_ACTIONS,
  WORKSPACE_ACCESS_ACTIONS,
  WorkspaceAccessGrant,
  type AssignWorkspaceAccessGrantRequest,
  type ProvisioningRevisionRequest,
  type WorkspaceAccessGrantPage,
  type WorkspaceAccessGrantQuery,
} from '@purlay/types/workspace-provisioning';
import { AppError } from '../../../platform/errors';
import { limitOf } from '../../../platform/pagination';
import { recordAudit } from '../../audit/audit';
import { administerWorkspaceAccess } from './administration';
import {
  groupNotFound,
  provisioningChanged,
  roleNotFound,
  sourceNotFound,
  type WorkspaceProvisioningActor,
  type WorkspaceProvisioningDependencies,
} from './authority';
import type { WorkspaceChannelGrantDescriptor } from './channel-grants-port';
import {
  accessGroupCounts,
  accessGroupUsers,
  lockedAccessGroup,
  publicAccessGroup,
} from './groups';
import type { WorkspaceAccessSourceRow } from './native-state';
import { projectWorkspaceAccess } from './projection';
import { publicAccessUser, sourceSummary } from './read-access';
import { lockedAccessRole, publicAccessRole } from './roles';
import {
  noteWorkspaceAccessChange,
  requireWorkspaceProjectionScope,
  type WorkspaceProjectionScope,
} from './scope';

type CoreGrant = Selectable<Database['workspace_access_role_grants']>;
interface GrantDescriptor {
  readonly id: string;
  readonly revision: string;
  readonly roleId: string;
  readonly sourceId: string | null;
  readonly groupId: string | null;
  readonly createdAt: Date | string;
  readonly channel: WorkspaceChannelGrantDescriptor['channel'] | null;
}

export const grantNotFound = (): AppError =>
  new AppError({ code: 'WORKSPACE_ACCESS_GRANT_NOT_FOUND', message: 'Access grant not found.' });

const coreDescriptor = (row: CoreGrant): GrantDescriptor => ({
  id: row.id,
  revision: row.revision,
  roleId: row.role_id,
  sourceId: row.source_id,
  groupId: row.group_id,
  createdAt: row.created_at,
  channel: null,
});

/** A scoped grant may target only a source already related to a current full native member. */
const lockedGrantSource = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  sourceId: string,
): Promise<WorkspaceAccessSourceRow> => {
  requireWorkspaceProjectionScope(transaction, scope);
  if (!Value.Check(Uuid, sourceId)) throw sourceNotFound();
  const row = await transaction
    .selectFrom('workspace_access_sources as source')
    .innerJoin('workspace_members as member', (join) =>
      join
        .onRef('member.workspace_id', '=', 'source.workspace_id')
        .onRef('member.user_id', '=', 'source.user_id'),
    )
    .innerJoin('users', 'users.id', 'source.user_id')
    .leftJoin('workspace_admission_controls as control', (join) =>
      join
        .onRef('control.workspace_id', '=', 'source.workspace_id')
        .onRef('control.user_id', '=', 'source.user_id'),
    )
    .selectAll('source')
    .where('source.workspace_id', '=', scope.workspaceId)
    .where('source.id', '=', sourceId)
    .where('source.state', '!=', 'retired')
    .where('source.access_kind', '=', 'member')
    .where('member.access_kind', '=', 'member')
    .where('users.deleted_at', 'is', null)
    .where('control.blocked_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) throw sourceNotFound();
  return row;
};

/** Every metadata table is loaded once for the bounded merged page. */
const publicGrants = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  descriptors: readonly GrantDescriptor[],
): Promise<readonly WorkspaceAccessGrant[]> => {
  requireWorkspaceProjectionScope(transaction, scope);
  if (descriptors.length === 0) return [];
  const roleIds = [...new Set(descriptors.map((row) => row.roleId))];
  const sourceIds = [
    ...new Set(descriptors.flatMap((row) => (row.sourceId === null ? [] : [row.sourceId]))),
  ];
  const groupIds = [
    ...new Set(descriptors.flatMap((row) => (row.groupId === null ? [] : [row.groupId]))),
  ];
  const roles = new Map(
    (
      await transaction
        .selectFrom('workspace_access_roles')
        .selectAll()
        .where('workspace_id', '=', scope.workspaceId)
        .where('id', 'in', roleIds)
        .execute()
    ).map((row) => [row.id, publicAccessRole(row)]),
  );
  const sources =
    sourceIds.length === 0
      ? []
      : await transaction
          .selectFrom('workspace_access_sources as source')
          .innerJoin('users', 'users.id', 'source.user_id')
          .leftJoin('workspace_members as member', (join) =>
            join
              .onRef('member.workspace_id', '=', 'source.workspace_id')
              .onRef('member.user_id', '=', 'source.user_id'),
          )
          .leftJoin('workspace_admission_controls as control', (join) =>
            join
              .onRef('control.workspace_id', '=', 'source.workspace_id')
              .onRef('control.user_id', '=', 'source.user_id'),
          )
          .selectAll('source')
          .select([
            'users.username',
            'users.display_name',
            'users.avatar_url',
            'member.user_id as member_id',
            'control.blocked_at',
          ])
          .where('source.workspace_id', '=', scope.workspaceId)
          .where('source.id', 'in', sourceIds)
          .execute();
  const sourceMap = new Map(
    sources.map((row) => [
      row.id,
      {
        source: sourceSummary(
          row,
          row.state === 'active' && row.member_id !== null && row.blocked_at === null,
        ),
        user: publicAccessUser({
          id: row.user_id,
          username: row.username,
          display_name: row.display_name,
          avatar_url: row.avatar_url,
        }),
      },
    ]),
  );
  const groups =
    groupIds.length === 0
      ? []
      : await transaction
          .selectFrom('workspace_access_groups')
          .selectAll()
          .where('workspace_id', '=', scope.workspaceId)
          .where('id', 'in', groupIds)
          .execute();
  const counts = await accessGroupCounts(transaction, scope, groupIds);
  const groupMap = new Map(
    groups.map((row) => [row.id, publicAccessGroup(row, counts.get(row.id) ?? 0)]),
  );
  return descriptors.map((row) => {
    const role = roles.get(row.roleId);
    const source = row.sourceId === null ? undefined : sourceMap.get(row.sourceId);
    const group = row.groupId === null ? undefined : groupMap.get(row.groupId);
    if (
      role === undefined ||
      (row.sourceId !== null) === (row.groupId !== null) ||
      (row.sourceId !== null && source === undefined) ||
      (row.groupId !== null && group === undefined)
    )
      throw new Error('An access grant lost its exact workspace metadata.');
    const subject =
      row.sourceId !== null && source !== undefined
        ? { kind: 'source' as const, sourceId: row.sourceId, ...source }
        : { kind: 'group' as const, groupId: row.groupId, group };
    const result = {
      id: row.id,
      revision: row.revision,
      roleId: row.roleId,
      role,
      subject,
      scope:
        row.channel === null
          ? { kind: 'workspace' as const }
          : {
              kind: 'channel' as const,
              channelId: row.channel.id,
              name: row.channel.name,
              type: row.channel.type,
            },
      createdAt: new Date(row.createdAt).toISOString(),
    };
    if (!Value.Check(WorkspaceAccessGrant, result))
      throw new Error('Stored access grant does not match its contract.');
    return result;
  });
};

const coreCandidates = async (
  transaction: Transaction,
  scope: WorkspaceProjectionScope,
  query: WorkspaceAccessGrantQuery,
  take: number,
): Promise<readonly GrantDescriptor[]> => {
  requireWorkspaceProjectionScope(transaction, scope);
  let statement = transaction
    .selectFrom('workspace_access_role_grants as grant')
    .innerJoin('workspace_access_roles as role', (join) =>
      join
        .onRef('role.workspace_id', '=', 'grant.workspace_id')
        .onRef('role.id', '=', 'grant.role_id'),
    )
    .leftJoin('workspace_access_sources as source', (join) =>
      join
        .onRef('source.workspace_id', '=', 'grant.workspace_id')
        .onRef('source.id', '=', 'grant.source_id'),
    )
    .leftJoin('users', 'users.id', 'source.user_id')
    .leftJoin('workspace_access_groups as access_group', (join) =>
      join
        .onRef('access_group.workspace_id', '=', 'grant.workspace_id')
        .onRef('access_group.id', '=', 'grant.group_id'),
    )
    .selectAll('grant')
    .where('grant.workspace_id', '=', scope.workspaceId)
    .orderBy('grant.id', 'desc')
    .limit(take);
  if (query.before !== undefined) statement = statement.where('grant.id', '<', query.before);
  if ('sourceId' in query) statement = statement.where('grant.source_id', '=', query.sourceId);
  if ('groupId' in query) statement = statement.where('grant.group_id', '=', query.groupId);
  const search = query.q?.trim();
  if (search !== undefined && search !== '')
    statement = statement.where(
      sql<boolean>`position(lower(${search} collate "C") in lower(concat_ws(' ', role.name, source.name, users.display_name, users.username, access_group.name) collate "C")) > 0`,
    );
  return (await statement.execute()).map(coreDescriptor);
};

export const listWorkspaceAccessGrants = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  query: WorkspaceAccessGrantQuery,
): Promise<WorkspaceAccessGrantPage> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'read',
    async (transaction, scope, context) => {
      const limit = limitOf(query);
      const core = await coreCandidates(transaction, scope, query, limit + 1);
      const channels =
        (await dependencies.channels.access?.grants?.list(
          transaction,
          context,
          scope,
          query,
          limit + 1,
        )) ?? [];
      const candidates = [...core, ...channels].sort((a, b) =>
        a.id === b.id ? 0 : a.id > b.id ? -1 : 1,
      );
      const data = [...(await publicGrants(transaction, scope, candidates.slice(0, limit)))];
      return { data, nextCursor: candidates.length > limit ? (data.at(-1)?.id ?? null) : null };
    },
  );

export const assignWorkspaceAccessGrant = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  input: AssignWorkspaceAccessGrantRequest,
): Promise<WorkspaceAccessGrant> =>
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'grant',
    async (transaction, scope, context) => {
      const role = await lockedAccessRole(transaction, scope, input.roleId);
      if (role.retired_at !== null) throw roleNotFound();
      if (role.revision !== input.roleRevision) throw provisioningChanged();
      const applicable: readonly string[] =
        input.scope.kind === 'workspace' ? WORKSPACE_ACCESS_ACTIONS : CHANNEL_ACCESS_ACTIONS;
      if (!role.capabilities.some((capability) => applicable.includes(capability)))
        throw new AppError({
          code: 'VALIDATION_FAILED',
          message: 'Choose a role with an action for this scope.',
          details: { fields: { roleId: 'This role has no action for the selected scope.' } },
        });
      let users: readonly string[];
      if (input.subject.kind === 'source') {
        const source = await lockedGrantSource(transaction, scope, input.subject.sourceId);
        if (source.revision !== input.subjectRevision) throw provisioningChanged();
        users = [source.user_id];
      } else {
        const group = await lockedAccessGroup(transaction, scope, input.subject.groupId);
        if (group.state === 'retired') throw groupNotFound();
        if (group.revision !== input.subjectRevision) throw provisioningChanged();
        users = await accessGroupUsers(transaction, scope, group.id);
      }
      let descriptor: GrantDescriptor;
      if (input.scope.kind === 'channel') {
        const port = dependencies.channels.access?.grants;
        if (port === undefined)
          throw new AppError({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found.' });
        await port.descriptor(transaction, context, scope, input.scope.channelId);
        const assigned = await port.assign(transaction, dependencies.clock, context, scope, {
          roleId: role.id,
          subject: input.subject,
          channelId: input.scope.channelId,
        });
        descriptor = assigned;
        if (!assigned.created) {
          const result = (await publicGrants(transaction, scope, [descriptor]))[0];
          if (result === undefined) throw grantNotFound();
          return result;
        }
      } else {
        let existing = transaction
          .selectFrom('workspace_access_role_grants')
          .selectAll()
          .where('workspace_id', '=', scope.workspaceId)
          .where('role_id', '=', role.id);
        existing =
          input.subject.kind === 'source'
            ? existing.where('source_id', '=', input.subject.sourceId)
            : existing.where('group_id', '=', input.subject.groupId);
        const row = await existing.executeTakeFirst();
        if (row !== undefined) {
          const result = (await publicGrants(transaction, scope, [coreDescriptor(row)]))[0];
          if (result === undefined) throw grantNotFound();
          return result;
        }
        descriptor = coreDescriptor(
          await transaction
            .insertInto('workspace_access_role_grants')
            .values({
              workspace_id: scope.workspaceId,
              role_id: role.id,
              source_id: input.subject.kind === 'source' ? input.subject.sourceId : null,
              group_id: input.subject.kind === 'group' ? input.subject.groupId : null,
              created_at: dependencies.clock.now(),
            })
            .returningAll()
            .executeTakeFirstOrThrow(),
        );
      }
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
        action: 'workspace.access.grant_assigned',
        targetType: 'workspace',
        targetId: scope.workspaceId,
        metadata: {
          grantId: descriptor.id,
          roleId: role.id,
          ...(descriptor.sourceId === null ? {} : { sourceId: descriptor.sourceId }),
          ...(descriptor.groupId === null ? {} : { groupId: descriptor.groupId }),
          ...(descriptor.channel === null ? {} : { channelId: descriptor.channel.id }),
        },
      });
      const result = (await publicGrants(transaction, scope, [descriptor]))[0];
      if (result === undefined) throw grantNotFound();
      return result;
    },
  );

export const revokeWorkspaceAccessGrant = async (
  dependencies: WorkspaceProvisioningDependencies,
  actor: WorkspaceProvisioningActor,
  grantId: string,
  input: ProvisioningRevisionRequest,
): Promise<void> => {
  await administerWorkspaceAccess(
    dependencies,
    actor,
    'revoke',
    async (transaction, scope, context) => {
      if (!Value.Check(Uuid, grantId)) throw grantNotFound();
      const core = await transaction
        .selectFrom('workspace_access_role_grants')
        .selectAll()
        .where('workspace_id', '=', scope.workspaceId)
        .where('id', '=', grantId)
        .executeTakeFirst();
      const descriptor =
        core === undefined
          ? await dependencies.channels.access?.grants?.find(transaction, context, scope, grantId)
          : coreDescriptor(core);
      if (descriptor === undefined) throw grantNotFound();
      if (descriptor.revision !== input.revision) throw provisioningChanged();
      const source =
        descriptor.sourceId === null
          ? undefined
          : await transaction
              .selectFrom('workspace_access_sources')
              .select('user_id')
              .where('workspace_id', '=', scope.workspaceId)
              .where('id', '=', descriptor.sourceId)
              .executeTakeFirstOrThrow();
      const users =
        source === undefined && descriptor.groupId !== null
          ? await accessGroupUsers(transaction, scope, descriptor.groupId)
          : source === undefined
            ? []
            : [source.user_id];
      if (core === undefined)
        await dependencies.channels.access?.grants?.revoke(transaction, context, scope, grantId);
      else
        await transaction
          .deleteFrom('workspace_access_role_grants')
          .where('workspace_id', '=', scope.workspaceId)
          .where('id', '=', grantId)
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
        action: 'workspace.access.grant_revoked',
        targetType: 'workspace',
        targetId: scope.workspaceId,
        metadata: {
          grantId,
          roleId: descriptor.roleId,
          ...(descriptor.sourceId === null ? {} : { sourceId: descriptor.sourceId }),
          ...(descriptor.groupId === null ? {} : { groupId: descriptor.groupId }),
          ...(descriptor.channel === null ? {} : { channelId: descriptor.channel.id }),
        },
      });
    },
  );
};
