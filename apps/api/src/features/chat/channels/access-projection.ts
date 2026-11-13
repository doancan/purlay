/** Native channel provenance and finite delegation share the workspace source transaction. */
import { sql } from '@purlay/db';
import type { Clock } from '../../../platform/clock';
import type { ChatDb, ChatTx } from '../schema';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../../platform/tenancy';
import { lockWorkspaceProjectionScope } from '../../../modules/workspaces/channels-port';
import { channelNotFound } from './guard';
import { AppError } from '../../../platform/errors';
const provisioningChanged = (): AppError =>
  new AppError({
    code: 'WORKSPACE_PROVISIONING_CHANGED',
    message: 'Workspace access changed. Reload before trying again.',
  });
import {
  noteWorkspaceChannelRevocation,
  requireWorkspaceProjectionScope,
  type WorkspaceProjectionScope,
} from '../../../modules/workspaces/channels-port';

/** No blocking channel-first lock is acquired after the workspace mutex. Busy writers cause a retry. */
export const projectChannelAccess = async (
  db: ChatTx,
  clock: Clock,
  scope: WorkspaceProjectionScope,
  userIds: readonly string[],
): Promise<readonly string[]> => {
  requireWorkspaceProjectionScope(db, scope);
  if (userIds.length === 0) return [];
  const workspaceId = scope.workspaceId;
  const now = clock.now();
  const expected = await db
    .selectFrom('channel_members')
    .innerJoin('channels', 'channels.id', 'channel_members.channel_id')
    .select(['channel_members.channel_id', 'channel_members.user_id'])
    .where('channels.workspace_id', '=', workspaceId)
    .where('channel_members.user_id', 'in', userIds)
    .execute();
  if (expected.length !== 0) {
    const held = await db
      .selectFrom('channel_members')
      .innerJoin('channels', 'channels.id', 'channel_members.channel_id')
      .select(['channel_members.channel_id', 'channel_members.user_id'])
      .where('channels.workspace_id', '=', workspaceId)
      .where('channel_members.user_id', 'in', userIds)
      .forUpdate('channel_members')
      .skipLocked()
      .execute();
    if (held.length !== expected.length) throw provisioningChanged();
  }
  const parentRows = await sql<{ id: string }>`
    select channel.id from channels channel
    where channel.workspace_id = ${workspaceId} and (
      exists (select 1 from channel_members member where member.channel_id = channel.id and member.user_id = any(${userIds}::uuid[]))
      or exists (select 1 from channel_access_controls control where control.channel_id = channel.id and control.user_id = any(${userIds}::uuid[]))
    )
  `.execute(db);
  const parents = parentRows.rows.map((row) => row.id);
  if (parents.length !== 0) {
    const heldParents = await db
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .where('id', 'in', parents)
      .forKeyShare()
      .skipLocked()
      .execute();
    if (heldParents.length !== parents.length) throw provisioningChanged();
  }
  // Only genuinely pre-existing native rows with no retained control are adopted once.
  await sql`
    with initialized as (
      insert into channel_access_controls (workspace_id, channel_id, user_id, initialized_at)
      select ${workspaceId}, member.channel_id, member.user_id, ${now}
      from channel_members member join channels channel on channel.id = member.channel_id
      where channel.workspace_id = ${workspaceId} and member.user_id = any(${userIds}::uuid[])
      on conflict (channel_id, user_id) do nothing returning channel_id, user_id
    )
    insert into channel_access_member_grants (workspace_id, channel_id, user_id, kind, admitted_at, created_at)
    select ${workspaceId}, initialized.channel_id, initialized.user_id, 'manual', member.joined_at, ${now}
    from initialized join channel_members member on member.channel_id = initialized.channel_id and member.user_id = initialized.user_id
  `.execute(db);
  // A permission grant never creates a native audience. Current native rows are removed only when their actual admission ends.
  const removed = await sql<{ channel_id: string; user_id: string }>`
    delete from channel_members member using channels channel
    where channel.id = member.channel_id and channel.workspace_id = ${workspaceId}
      and member.user_id = any(${userIds}::uuid[])
      and (not exists (
        select 1 from workspace_admission_controls admission
        join workspace_access_sources source on source.workspace_id = admission.workspace_id and source.user_id = admission.user_id
        where admission.workspace_id = ${workspaceId} and admission.user_id = member.user_id
          and admission.blocked_at is null and source.state = 'active'
      ) or not exists (
        select 1 from channel_access_member_grants member_grant
        left join workspace_access_sources source on source.workspace_id = member_grant.workspace_id and source.id = member_grant.source_id
        left join workspace_access_groups access_group on access_group.workspace_id = member_grant.workspace_id and access_group.id = member_grant.group_id
        where member_grant.workspace_id = ${workspaceId} and member_grant.channel_id = member.channel_id and member_grant.user_id = member.user_id
          and (member_grant.kind = 'manual' or (source.state = 'active' and (member_grant.kind = 'source' or access_group.state = 'active')))
      ))
    returning member.channel_id, member.user_id
  `.execute(db);
  for (const userId of userIds) {
    const channelIds = removed.rows
      .filter((row) => row.user_id === userId)
      .map((row) => row.channel_id);
    if (channelIds.length !== 0) noteWorkspaceChannelRevocation(db, scope, userId, channelIds);
  }
  await sql`
    insert into channel_members (channel_id, user_id, joined_at)
    select member_grant.channel_id, member_grant.user_id, min(member_grant.admitted_at)
    from channel_access_member_grants member_grant
    join workspace_members workspace_member on workspace_member.workspace_id = member_grant.workspace_id and workspace_member.user_id = member_grant.user_id and workspace_member.access_kind = 'member'
    join workspace_admission_controls admission on admission.workspace_id = workspace_member.workspace_id and admission.user_id = workspace_member.user_id and admission.blocked_at is null
    left join workspace_access_sources issuing_source on issuing_source.workspace_id = member_grant.workspace_id and issuing_source.id = member_grant.source_id
    left join workspace_access_groups issuing_group on issuing_group.workspace_id = member_grant.workspace_id and issuing_group.id = member_grant.group_id
    where member_grant.workspace_id = ${workspaceId} and member_grant.user_id = any(${userIds}::uuid[])
      and exists (select 1 from workspace_access_sources base where base.workspace_id = member_grant.workspace_id and base.user_id = member_grant.user_id and base.state = 'active')
      and (member_grant.kind = 'manual' or (issuing_source.state = 'active' and (member_grant.kind = 'source' or issuing_group.state = 'active')))
    group by member_grant.channel_id, member_grant.user_id
    on conflict (channel_id, user_id) do nothing
  `.execute(db);
  await db
    .deleteFrom('channel_member_capabilities')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', 'in', userIds)
    .execute();
  await db
    .updateTable('channel_access_controls')
    .set({ revision: sql<string>`gen_random_uuid()` })
    .where('workspace_id', '=', workspaceId)
    .where('user_id', 'in', userIds)
    .execute();
  await sql`
    with contribution as (
      select role_grant.channel_id, source.user_id, unnest(role.capabilities) as capability
      from channel_access_role_grants role_grant
      join workspace_access_roles role on role.workspace_id = role_grant.workspace_id and role.id = role_grant.role_id
      join workspace_access_sources source on source.workspace_id = role_grant.workspace_id and source.id = role_grant.source_id
      where role_grant.workspace_id = ${workspaceId} and source.user_id = any(${userIds}::uuid[])
        and source.state = 'active' and source.access_kind = 'member' and role.retired_at is null
      union
      select role_grant.channel_id, source.user_id, unnest(role.capabilities) as capability
      from channel_access_role_grants role_grant
      join workspace_access_roles role on role.workspace_id = role_grant.workspace_id and role.id = role_grant.role_id
      join workspace_access_groups access_group on access_group.workspace_id = role_grant.workspace_id and access_group.id = role_grant.group_id
      join workspace_access_group_members group_member on group_member.workspace_id = access_group.workspace_id and group_member.group_id = access_group.id
      join workspace_access_sources source on source.workspace_id = group_member.workspace_id and source.user_id = group_member.user_id and source.id = group_member.source_id
      where role_grant.workspace_id = ${workspaceId} and source.user_id = any(${userIds}::uuid[])
        and access_group.state = 'active' and source.state = 'active' and source.access_kind = 'member' and role.retired_at is null
    )
    insert into channel_member_capabilities (workspace_id, channel_id, user_id, capability, projection_revision)
    select distinct ${workspaceId}::uuid, contribution.channel_id, contribution.user_id, contribution.capability, control.revision
    from contribution
    join channels channel on channel.workspace_id = ${workspaceId} and channel.id = contribution.channel_id and channel.type <> 'direct_message'
    join channel_members member on member.channel_id = channel.id and member.user_id = contribution.user_id
    join workspace_members workspace_member on workspace_member.workspace_id = channel.workspace_id and workspace_member.user_id = member.user_id and workspace_member.access_kind = 'member'
    join workspace_admission_controls admission on admission.workspace_id = channel.workspace_id and admission.user_id = member.user_id and admission.blocked_at is null
    join channel_access_controls control on control.workspace_id = channel.workspace_id and control.channel_id = channel.id and control.user_id = member.user_id
    where contribution.capability in ('channel.settings.manage', 'channel.members.manage')
  `.execute(db);
  return [...new Set(removed.rows.map((row) => row.channel_id))];
};

export const channelAccessCount = async (
  db: ChatDb,
  workspaceId: string,
  userId: string,
): Promise<number> => {
  const row = await db
    .selectFrom('channel_members')
    .innerJoin('channels', 'channels.id', 'channel_members.channel_id')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('channels.workspace_id', '=', workspaceId)
    .where('channel_members.user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
};
export const channelRoleUsers = async (
  db: ChatDb,
  workspaceId: string,
  roleId: string,
): Promise<readonly string[]> => {
  const result = await sql<{ user_id: string }>`
    select source.user_id from channel_access_role_grants role_grant
    join workspace_access_sources source on source.workspace_id = role_grant.workspace_id and source.id = role_grant.source_id
    where role_grant.workspace_id = ${workspaceId} and role_grant.role_id = ${roleId}
    union
    select member.user_id from channel_access_role_grants role_grant
    join workspace_access_group_members member on member.workspace_id = role_grant.workspace_id and member.group_id = role_grant.group_id
    where role_grant.workspace_id = ${workspaceId} and role_grant.role_id = ${roleId}
  `.execute(db);
  return result.rows.map((row) => row.user_id);
};

/** An actual create/join/add takes the workspace mutex before its INSERT, then records explicit manual provenance. */
export const prepareManualChannelAdmission = async (
  db: ChatTx,
  clock: Clock,
  context: Pick<WorkspaceContext, 'workspaceId' | 'userId'>,
  userIds: readonly string[],
): Promise<(channelId: string) => Promise<void>> => {
  const controlled = await db
    .selectFrom('workspace_admission_controls')
    .select('user_id')
    .where('workspace_id', '=', context.workspaceId)
    .where('user_id', 'in', userIds)
    .execute();
  const ids = controlled.map((row) => row.user_id);
  if (ids.length === 0) return (): Promise<void> => Promise.resolve();
  const scope = await lockWorkspaceProjectionScope(db, context.workspaceId);
  await requireWorkspaceMembership(db, context.userId, context.workspaceId);
  const present = await db
    .selectFrom('workspace_members')
    .innerJoin('workspace_admission_controls', (join) =>
      join
        .onRef('workspace_admission_controls.workspace_id', '=', 'workspace_members.workspace_id')
        .onRef('workspace_admission_controls.user_id', '=', 'workspace_members.user_id'),
    )
    .select('workspace_members.user_id')
    .where('workspace_members.workspace_id', '=', context.workspaceId)
    .where('workspace_members.user_id', 'in', ids)
    .where('workspace_admission_controls.blocked_at', 'is', null)
    .execute();
  if (present.length !== ids.length) throw channelNotFound();
  return async (channelId): Promise<void> => {
    const native = await db
      .selectFrom('channel_members')
      .select(['user_id', 'joined_at'])
      .where('channel_id', '=', channelId)
      .where('user_id', 'in', ids)
      .execute();
    if (native.length !== ids.length) throw channelNotFound();
    await db
      .insertInto('channel_access_controls')
      .values(
        native.map((member) => ({
          workspace_id: context.workspaceId,
          channel_id: channelId,
          user_id: member.user_id,
          initialized_at: clock.now(),
        })),
      )
      .onConflict((conflict) => conflict.columns(['channel_id', 'user_id']).doNothing())
      .execute();
    await db
      .insertInto('channel_access_member_grants')
      .values(
        native.map((member) => ({
          workspace_id: context.workspaceId,
          channel_id: channelId,
          user_id: member.user_id,
          kind: 'manual',
          admitted_at: member.joined_at,
          created_at: clock.now(),
        })),
      )
      .onConflict((conflict) =>
        conflict.columns(['channel_id', 'user_id']).where('kind', '=', 'manual').doNothing(),
      )
      .execute();
    await projectChannelAccess(db, clock, scope, ids);
  };
};
