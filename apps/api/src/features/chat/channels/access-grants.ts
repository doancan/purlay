/** Exact non-DM visibility stays independent from a management role grant. */
import { sql, type SelectQueryBuilder, type RawBuilder } from '@purlay/db';
import type { ChatTx, ChatSchema } from '../schema';
import type { Channel } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { Uuid } from '@purlay/types';
import type { WorkspaceAccessGrantQuery } from '@purlay/types/workspace-provisioning';
import type { Clock } from '../../../platform/clock';
import { AppError } from '../../../platform/errors';
import {
  assertMinted,
  requireFullMembership,
  requireWorkspaceMembership,
  type WorkspaceContext,
} from '../../../platform/tenancy';
import type {
  WorkspaceChannelGrantDescriptor,
  WorkspaceChannelGrantsPort,
  WorkspaceGrantChannel,
} from '../../../modules/workspaces/channels-port';
import {
  requireWorkspaceProjectionScope,
  type WorkspaceProjectionScope,
} from '../../../modules/workspaces/channels-port';
import { channelNotFound, visibleChannels } from './guard';

const requireScope = async (
  transaction: ChatTx,
  context: WorkspaceContext,
  scope: WorkspaceProjectionScope,
): Promise<void> => {
  requireWorkspaceProjectionScope(transaction, scope);
  assertMinted(context);
  if (context.workspaceId !== scope.workspaceId) throw channelNotFound();
  const fresh = await requireWorkspaceMembership(transaction, context.userId, scope.workspaceId);
  requireFullMembership(fresh, 'Only full members manage channel roles.');
  if (fresh.role !== 'owner' && fresh.role !== 'admin')
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner or an admin manages access grants.',
    });
};

const visibleIds = (transaction: ChatTx, context: WorkspaceContext): RawBuilder<string> =>
  sql<string>`${visibleChannels(transaction, context.userId, { includeArchived: true }).select('channels.id').where('channels.workspace_id', '=', context.workspaceId)}`;

const descriptor = async (
  transaction: ChatTx,
  context: WorkspaceContext,
  scope: WorkspaceProjectionScope,
  channelId: string,
): Promise<WorkspaceGrantChannel> => {
  await requireScope(transaction, context, scope);
  if (!Value.Check(Uuid, channelId)) throw channelNotFound();
  const channel = await transaction
    .selectFrom('channels')
    .select(['id', 'name', 'type'])
    .where('workspace_id', '=', scope.workspaceId)
    .where('id', '=', channelId)
    .where('id', 'in', visibleIds(transaction, context))
    .where('type', 'in', ['public', 'private'])
    .executeTakeFirst();
  if (channel?.name == null || (channel.type !== 'public' && channel.type !== 'private'))
    throw channelNotFound();
  return { id: channel.id, name: channel.name, type: channel.type };
};

const grantsQuery = (
  transaction: ChatTx,
  context: WorkspaceContext,
  scope: WorkspaceProjectionScope,
): GrantQuery =>
  transaction
    .selectFrom('channel_access_role_grants as role_grant')
    .innerJoin('channels', (join) =>
      join
        .onRef('channels.workspace_id', '=', 'role_grant.workspace_id')
        .onRef('channels.id', '=', 'role_grant.channel_id'),
    )
    .innerJoin('workspace_access_roles as access_role', (join) =>
      join
        .onRef('access_role.workspace_id', '=', 'role_grant.workspace_id')
        .onRef('access_role.id', '=', 'role_grant.role_id'),
    )
    .leftJoin('workspace_access_sources as source', (join) =>
      join
        .onRef('source.workspace_id', '=', 'role_grant.workspace_id')
        .onRef('source.id', '=', 'role_grant.source_id'),
    )
    .leftJoin('users as source_user', 'source_user.id', 'source.user_id')
    .leftJoin('workspace_access_groups as access_group', (join) =>
      join
        .onRef('access_group.workspace_id', '=', 'role_grant.workspace_id')
        .onRef('access_group.id', '=', 'role_grant.group_id'),
    )
    .select([
      'role_grant.id',
      'role_grant.revision',
      'role_grant.role_id',
      'role_grant.source_id',
      'role_grant.group_id',
      'role_grant.created_at',
      'channels.id as channel_id',
      'channels.name as channel_name',
      'channels.type as channel_type',
    ])
    .where('role_grant.workspace_id', '=', scope.workspaceId)
    .where('channels.id', 'in', visibleIds(transaction, context))
    .where('channels.type', 'in', ['public', 'private'])
    .where((eb) =>
      eb.or([
        eb.and([eb('source.id', 'is not', null), eb('source_user.deleted_at', 'is', null)]),
        eb('access_group.id', 'is not', null),
      ]),
    );

interface GrantRow {
  readonly id: string;
  readonly revision: string;
  readonly role_id: string;
  readonly source_id: string | null;
  readonly group_id: string | null;
  readonly created_at: Date;
  readonly channel_id: string;
  readonly channel_name: string | null;
  readonly channel_type: Channel['type'];
}
type GrantQuery = SelectQueryBuilder<
  ChatSchema & {
    role_grant: ChatSchema['channel_access_role_grants'];
    access_role: ChatSchema['workspace_access_roles'];
    source: ChatSchema['workspace_access_sources'];
    source_user: ChatSchema['users'];
    access_group: ChatSchema['workspace_access_groups'];
  },
  'role_grant' | 'channels' | 'access_role' | 'source' | 'source_user' | 'access_group',
  GrantRow
>;
const publicDescriptor = (row: GrantRow): WorkspaceChannelGrantDescriptor => {
  if (
    row.channel_name === null ||
    (row.channel_type !== 'public' && row.channel_type !== 'private')
  )
    throw channelNotFound();
  return {
    id: row.id,
    revision: row.revision,
    roleId: row.role_id,
    sourceId: row.source_id,
    groupId: row.group_id,
    channel: { id: row.channel_id, name: row.channel_name, type: row.channel_type },
    createdAt: row.created_at,
  };
};

const list = async (
  transaction: ChatTx,
  context: WorkspaceContext,
  scope: WorkspaceProjectionScope,
  query: WorkspaceAccessGrantQuery,
  take: number,
): Promise<readonly WorkspaceChannelGrantDescriptor[]> => {
  await requireScope(transaction, context, scope);
  if (!Number.isSafeInteger(take) || take < 1 || take > 101)
    throw new Error('Channel grant listing requires a bounded page.');
  let statement = grantsQuery(transaction, context, scope)
    .orderBy('role_grant.id', 'desc')
    .limit(take);
  if (query.before !== undefined) statement = statement.where('role_grant.id', '<', query.before);
  if ('sourceId' in query) statement = statement.where('role_grant.source_id', '=', query.sourceId);
  if ('groupId' in query) statement = statement.where('role_grant.group_id', '=', query.groupId);
  const search = query.q?.trim();
  if (search !== undefined && search !== '')
    statement = statement.where(
      sql<boolean>`position(lower(${search} collate "C") in lower(concat_ws(' ', access_role.name, source.name, source_user.display_name, source_user.username, access_group.name, channels.name) collate "C")) > 0`,
    );
  return (await statement.execute()).map(publicDescriptor);
};

const find = async (
  transaction: ChatTx,
  context: WorkspaceContext,
  scope: WorkspaceProjectionScope,
  id: string,
): Promise<WorkspaceChannelGrantDescriptor | undefined> => {
  await requireScope(transaction, context, scope);
  if (!Value.Check(Uuid, id)) return undefined;
  const row = await grantsQuery(transaction, context, scope)
    .where('role_grant.id', '=', id)
    .executeTakeFirst();
  return row === undefined ? undefined : publicDescriptor(row);
};

export const chatChannelAccessGrants: WorkspaceChannelGrantsPort = {
  descriptor,
  list,
  find,
  assign: async (transaction, clock: Clock, context, scope, input) => {
    const channel = await descriptor(transaction, context, scope, input.channelId);
    const row = await transaction
      .insertInto('channel_access_role_grants')
      .values({
        workspace_id: scope.workspaceId,
        channel_id: channel.id,
        role_id: input.roleId,
        source_id: input.subject.kind === 'source' ? input.subject.sourceId : null,
        group_id: input.subject.kind === 'group' ? input.subject.groupId : null,
        created_at: clock.now(),
      })
      .onConflict((conflict) =>
        input.subject.kind === 'source'
          ? conflict
              .columns(['channel_id', 'role_id', 'source_id'])
              .where('source_id', 'is not', null)
              .doNothing()
          : conflict
              .columns(['channel_id', 'role_id', 'group_id'])
              .where('group_id', 'is not', null)
              .doNothing(),
      )
      .returning('id')
      .executeTakeFirst();
    let result: WorkspaceChannelGrantDescriptor | undefined;
    if (row !== undefined) result = await find(transaction, context, scope, row.id);
    else {
      let statement = grantsQuery(transaction, context, scope)
        .where('role_grant.channel_id', '=', channel.id)
        .where('role_grant.role_id', '=', input.roleId);
      statement =
        input.subject.kind === 'source'
          ? statement.where('role_grant.source_id', '=', input.subject.sourceId)
          : statement.where('role_grant.group_id', '=', input.subject.groupId);
      const existing = await statement.executeTakeFirst();
      result = existing === undefined ? undefined : publicDescriptor(existing);
    }
    if (result === undefined)
      throw new Error('Assigned channel grant was not visible to its author.');
    return { ...result, created: row !== undefined };
  },
  revoke: async (transaction, context, scope, id) => {
    if ((await find(transaction, context, scope, id)) === undefined)
      throw new AppError({
        code: 'WORKSPACE_ACCESS_GRANT_NOT_FOUND',
        message: 'Access grant not found.',
      });
    await transaction
      .deleteFrom('channel_access_role_grants')
      .where('workspace_id', '=', scope.workspaceId)
      .where('id', '=', id)
      .execute();
  },
};
