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
      .forShare()
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
  grant: async (executor, clock, context, userId, channelIds) => {
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
