/** Exact channel delegation is a current projection over native membership, never a visibility grant. */
import { sql, tableExists, type RawBuilder, type SelectQueryBuilder } from '@purlay/db';
import { ChannelAccessAction } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import type { ChatDb, ChatSchema } from '../schema';
import { visibleChannels, type ChannelContext } from './guard';

type CapabilityQuery = SelectQueryBuilder<
  ChatSchema,
  | 'channels'
  | 'workspaces'
  | 'workspace_members'
  | 'channel_members'
  | 'channel_member_capabilities'
  | 'channel_access_controls'
  | 'workspace_admission_controls'
  | 'users',
  object
>;
const capabilityQuery = (
  executor: ChatDb,
  userId: string,
  {
    includeArchived,
    visibilityOnly = true,
    capability,
    ordered = false,
  }: {
    readonly includeArchived: boolean;
    readonly visibilityOnly?: boolean;
    readonly capability?: ChannelAccessAction;
    readonly ordered?: boolean;
  },
): CapabilityQuery => {
  let query = visibleChannels(executor, userId, { visibilityOnly, includeArchived })
    .innerJoin('channel_member_capabilities', (join) =>
      join
        .onRef('channel_member_capabilities.channel_id', '=', 'channels.id')
        .onRef('channel_member_capabilities.workspace_id', '=', 'channels.workspace_id')
        .on('channel_member_capabilities.user_id', '=', userId),
    )
    .innerJoin('channel_access_controls', (join) =>
      join
        .onRef(
          'channel_access_controls.workspace_id',
          '=',
          'channel_member_capabilities.workspace_id',
        )
        .onRef('channel_access_controls.channel_id', '=', 'channel_member_capabilities.channel_id')
        .onRef('channel_access_controls.user_id', '=', 'channel_member_capabilities.user_id')
        .onRef(
          'channel_access_controls.revision',
          '=',
          'channel_member_capabilities.projection_revision',
        ),
    )
    .innerJoin('workspace_admission_controls', (join) =>
      join
        .onRef('workspace_admission_controls.workspace_id', '=', 'channels.workspace_id')
        .on('workspace_admission_controls.user_id', '=', userId),
    )
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .where('workspace_admission_controls.blocked_at', 'is', null)
    .where('workspace_members.access_kind', '=', 'member')
    .where('channel_members.user_id', '=', userId)
    .where('channels.type', '!=', 'direct_message')
    .where('users.deleted_at', 'is', null)
    .where('users.suspended_at', 'is', null)
    .where('users.admission_state', '=', 'approved')
    .where((eb) =>
      eb.or([
        eb('users.admission_requires_verified_email', '=', false),
        eb('users.email_verified', '=', true),
      ]),
    );
  if (capability !== undefined)
    query = query.where('channel_member_capabilities.capability', '=', capability);
  if (ordered) query = query.orderBy('channel_member_capabilities.capability');
  return query;
};

export const channelCapabilityPredicate = (
  executor: ChatDb,
  userId: string,
  channelId: string | RawBuilder<string>,
  capability: ChannelAccessAction,
  includeArchived = false,
): RawBuilder<boolean> =>
  sql<boolean>`${channelId} in (${capabilityQuery(executor, userId, { includeArchived, visibilityOnly: false, capability }).select('channels.id')})`;
export const hasChannelCapability = async (
  executor: ChatDb,
  context: Pick<ChannelContext, 'workspaceId' | 'userId' | 'channelId'>,
  capability: ChannelAccessAction,
  includeArchived = false,
): Promise<boolean> => {
  if (!(await tableExists(executor, 'channel_member_capabilities'))) return false;
  const row = await capabilityQuery(executor, context.userId, {
    includeArchived,
    visibilityOnly: false,
    capability,
  })
    .select('channels.id')
    .where('channels.workspace_id', '=', context.workspaceId)
    .where('channels.id', '=', context.channelId)
    .executeTakeFirst();
  return row !== undefined;
};
export const channelCapabilitiesFor = async (
  executor: ChatDb,
  userId: string,
  channelIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ChannelAccessAction[]>> => {
  const result = new Map<string, ChannelAccessAction[]>();
  if (channelIds.length === 0 || !(await tableExists(executor, 'channel_member_capabilities')))
    return result;
  const rows = await capabilityQuery(executor, userId, { includeArchived: false, ordered: true })
    .select(['channels.id', 'channel_member_capabilities.capability'])
    .where('channels.id', 'in', [...new Set(channelIds)])
    .distinct()
    .execute();
  for (const row of rows) {
    if (!Value.Check(ChannelAccessAction, row.capability))
      throw new Error('A channel capability is outside the supported vocabulary.');
    const actions = result.get(row.id) ?? [];
    actions.push(row.capability);
    result.set(row.id, actions);
  }
  return result;
};
/** At most two navigation hints per requested workspace, with no private channel IDs. */
export const aggregateChannelCapabilities = async (
  executor: ChatDb,
  userId: string,
  workspaceIds: readonly string[],
): Promise<ReadonlyMap<string, readonly ChannelAccessAction[]>> => {
  const result = new Map<string, ChannelAccessAction[]>();
  if (workspaceIds.length === 0 || !(await tableExists(executor, 'channel_member_capabilities')))
    return result;
  const rows = await capabilityQuery(executor, userId, { includeArchived: true, ordered: true })
    .select(['channels.workspace_id', 'channel_member_capabilities.capability'])
    .where('channels.workspace_id', 'in', [...new Set(workspaceIds)])
    .distinct()
    .execute();
  for (const row of rows) {
    if (!Value.Check(ChannelAccessAction, row.capability))
      throw new Error('A channel capability is outside the supported vocabulary.');
    const actions = result.get(row.workspace_id) ?? [];
    actions.push(row.capability);
    result.set(row.workspace_id, actions);
  }
  return result;
};
