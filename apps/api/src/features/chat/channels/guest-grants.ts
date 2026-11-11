/** Chat owns guest conversation grants and directory scope; core never reaches into chat's tables. */
import { Value } from '@sinclair/typebox/value';
import { GUEST_CHANNELS_MAX, GuestChannelIds } from '@purlay/types';
import type { ChatDb } from '../schema';
import { sql } from '@purlay/db';
import type { WorkspaceGuestChannels } from '../../../modules/workspaces/channels-port';
import { AppError, routeNotFound } from '../../../platform/errors';
import {
  assertMinted,
  entitledTo,
  requireWorkspaceMembership,
  type WorkspaceContext,
} from '../../../platform/tenancy';
import {
  requireChannelsById,
  channelNotFound,
  visibleChannelIdsQuery,
  channelAudienceQuery,
} from './guard';
import { beginReadScopes } from './read-scope';
import { prepareGuestScopeEdit } from './guest-scope';
import { forgetWorkspaceChannels } from './workspace-channel-cleanup';

const administrator = async (
  executor: ChatDb,
  context: WorkspaceContext,
): Promise<WorkspaceContext> => {
  assertMinted(context);
  const current = await requireWorkspaceMembership(executor, context.userId, context.workspaceId);
  if (current.role === 'member')
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner or an admin manages guest access.',
    });
  if (!entitledTo(current, 'chat')) throw routeNotFound();
  return current;
};

export const chatGuestChannels: WorkspaceGuestChannels = {
  moduleId: 'chat',
  prepareEdit: async (executor, context, userId, channelIds) =>
    await prepareGuestScopeEdit(
      executor,
      await administrator(executor, context),
      userId,
      channelIds,
    ),
  scopes: async (executor, context, userIds) => {
    const current = await administrator(executor, context);
    const scopes = new Map<string, { visibleIds: string[]; hiddenCount: number }>();
    if (userIds.length === 0) return scopes;
    const rows = await executor
      .selectFrom('channel_members')
      .innerJoin('channels', 'channels.id', 'channel_members.channel_id')
      .innerJoin('workspace_members', (join) =>
        join
          .onRef('workspace_members.workspace_id', '=', 'channels.workspace_id')
          .onRef('workspace_members.user_id', '=', 'channel_members.user_id'),
      )
      .select(['channel_members.user_id', 'channels.id'])
      .select((eb) =>
        eb('channels.id', 'in', visibleChannelIdsQuery(executor, current)).as('visible'),
      )
      .where('workspace_members.workspace_id', '=', current.workspaceId)
      .where('workspace_members.access_kind', '=', 'guest')
      .where('channel_members.user_id', 'in', userIds)
      .orderBy('channels.id')
      .execute();
    for (const row of rows) {
      const scope = scopes.get(row.user_id) ?? { visibleIds: [], hiddenCount: 0 };
      if (row.visible === true) scope.visibleIds.push(row.id);
      else scope.hiddenCount += 1;
      scopes.set(row.user_id, scope);
    }
    return scopes;
  },
  people: (executor, context, personId) => {
    assertMinted(context);
    if (!entitledTo(context, 'chat')) return sql<boolean>`false`;
    const shared = executor
      .selectFrom(visibleChannelIdsQuery(executor, context).as('shared_channel'))
      .innerJoin('channel_members as colleague', 'colleague.channel_id', 'shared_channel.id')
      .select('colleague.user_id')
      .where('colleague.user_id', '=', personId)
      .where(
        'colleague.user_id',
        'in',
        channelAudienceQuery(executor, sql.ref<string>('shared_channel.id')),
      );
    return sql<boolean>`exists (${shared})`;
  },
  prepare: async (executor, context, channelIds) => {
    const current = await administrator(executor, context);
    if (!Value.Check(GuestChannelIds, channelIds))
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'Choose between one and twenty distinct channels.',
        details: { fields: { channelIds: 'Choose distinct channels.' } },
      });
    await executor
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', current.workspaceId)
      .where('id', 'in', channelIds)
      .where('id', 'in', visibleChannelIdsQuery(executor, current))
      .where('deleted_at', 'is', null)
      .where('type', '!=', 'direct_message')
      .orderBy('id')
      // Sends take KEY SHARE through their message FK before counting recipients. UPDATE makes
      // them wait until admission commits, so a newly readable message is counted for the guest.
      .forUpdate()
      .execute();
    const visible = await requireChannelsById(executor, current.userId, channelIds);
    if (
      visible.some(
        (channel) =>
          channel.workspaceId !== current.workspaceId || channel.channelType === 'direct_message',
      )
    )
      throw channelNotFound();
  },
  grant: async (executor, clock, context, userId, channelIds, newAdmission = false) => {
    await chatGuestChannels.prepare(executor, context, channelIds);
    await executor
      .selectFrom('workspace_members')
      .select('id')
      .where('workspace_id', '=', context.workspaceId)
      .where('user_id', '=', userId)
      .forUpdate()
      .execute();
    const target = await requireWorkspaceMembership(executor, userId, context.workspaceId);
    if (target.guest === undefined || !entitledTo(target, 'chat'))
      throw new AppError({
        code: 'FORBIDDEN',
        message: 'This grant requires a restricted guest membership.',
      });
    if (newAdmission) await forgetWorkspaceChannels(executor, context.workspaceId, userId);
    const existing = await executor
      .selectFrom('channel_members')
      .innerJoin('channels', 'channels.id', 'channel_members.channel_id')
      .select('channel_members.channel_id')
      .where('channels.workspace_id', '=', context.workspaceId)
      .where('channel_members.user_id', '=', userId)
      .execute();
    if (
      new Set([...existing.map((row) => row.channel_id), ...channelIds]).size > GUEST_CHANNELS_MAX
    )
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'A guest has at most twenty channels.',
        details: { fields: { channelIds: 'Remove a channel before granting another.' } },
      });
    const joinedAt = clock.now();
    const inserted = await executor
      .insertInto('channel_members')
      .values(
        channelIds.map((channelId) => ({
          channel_id: channelId,
          user_id: userId,
          joined_at: joinedAt,
        })),
      )
      .onConflict((conflict) => conflict.columns(['channel_id', 'user_id']).doNothing())
      .returning('channel_id')
      .execute();
    await beginReadScopes(
      executor,
      inserted.map((row) => row.channel_id),
      [userId],
      joinedAt,
    );
  },
};
