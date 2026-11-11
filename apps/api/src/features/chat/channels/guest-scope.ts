/** A guest edit holds channel rows before core's membership mutex and never exposes hidden scope IDs. */
import { sql } from '@purlay/db';
import { GUEST_CHANNELS_MAX } from '@purlay/types';
import type { WorkspaceGuestChannels } from '../../../modules/workspaces/channels-port';
import { AppError, routeNotFound } from '../../../platform/errors';
import {
  entitledTo,
  requireWorkspaceMembership,
  type WorkspaceContext,
} from '../../../platform/tenancy';
import type { ChatTx } from '../schema';
import { channelNotFound, requireChannelsById, visibleChannelIdsQuery } from './guard';
import { beginReadScopes } from './read-scope';

interface Grant {
  readonly id: string;
  readonly joined_at: Date;
  readonly visible: boolean;
}

type ScopeEdit = Awaited<ReturnType<WorkspaceGuestChannels['prepareEdit']>>;

const grants = async (
  transaction: ChatTx,
  context: WorkspaceContext,
  userId: string,
): Promise<readonly Grant[]> =>
  await transaction
    .selectFrom('channel_members')
    .innerJoin('channels', 'channels.id', 'channel_members.channel_id')
    .select(['channels.id', 'channel_members.joined_at'])
    .select((eb) =>
      sql<boolean>`${eb('channels.id', 'in', visibleChannelIdsQuery(transaction, context))}`.as(
        'visible',
      ),
    )
    .where('channels.workspace_id', '=', context.workspaceId)
    .where('channel_members.user_id', '=', userId)
    .orderBy('channels.id')
    .execute();

const validateSelection = async (
  transaction: ChatTx,
  context: WorkspaceContext,
  channelIds: readonly string[] | undefined,
): Promise<void> => {
  if (channelIds === undefined || channelIds.length === 0) return;
  const channels = await requireChannelsById(transaction, context.userId, channelIds);
  if (
    channels.some(
      (channel) =>
        channel.workspaceId !== context.workspaceId || channel.channelType === 'direct_message',
    )
  )
    throw channelNotFound();
};

export const prepareGuestScopeEdit: WorkspaceGuestChannels['prepareEdit'] = async (
  transaction,
  context,
  userId,
  channelIds,
) => {
  const before = await grants(transaction, context, userId);
  const lockIds = [...new Set([...before.map((row) => row.id), ...(channelIds ?? [])])];
  if (lockIds.length > 0)
    await transaction
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', context.workspaceId)
      .where('id', 'in', lockIds)
      .orderBy('id')
      .forUpdate()
      .execute();
  await validateSelection(transaction, context, channelIds);
  return {
    apply: async (at, resetHistory): ReturnType<ScopeEdit['apply']> => {
      const current = await requireWorkspaceMembership(
        transaction,
        context.userId,
        context.workspaceId,
      );
      if (current.role === 'member')
        throw new AppError({
          code: 'FORBIDDEN',
          message: 'Only an owner or an admin manages guest access.',
        });
      if (!entitledTo(current, 'chat')) throw routeNotFound();
      const target = await transaction
        .selectFrom('workspace_members')
        .select('id')
        .where('workspace_id', '=', current.workspaceId)
        .where('user_id', '=', userId)
        .where('access_kind', '=', 'guest')
        .executeTakeFirst();
      if (target === undefined)
        throw new AppError({
          code: 'USER_NOT_FOUND',
          message: 'That guest is not in this workspace.',
        });
      const latest = await grants(transaction, current, userId);
      if (JSON.stringify(latest) !== JSON.stringify(before))
        throw new AppError({
          code: 'VALIDATION_FAILED',
          message: 'Guest scope changed. Reload it before editing.',
          details: { fields: { channelIds: 'Reload the guest scope before editing.' } },
        });
      await validateSelection(transaction, current, channelIds);
      const wanted = new Set(
        channelIds === undefined
          ? latest.map((row) => row.id)
          : [...latest.filter((row) => !row.visible).map((row) => row.id), ...channelIds],
      );
      if (wanted.size > GUEST_CHANNELS_MAX)
        throw new AppError({
          code: 'VALIDATION_FAILED',
          message: 'A guest has at most twenty channels.',
          details: { fields: { channelIds: 'Remove a channel before granting another.' } },
        });
      const previous = new Set(latest.map((row) => row.id));
      const removedIds = latest.filter((row) => !wanted.has(row.id)).map((row) => row.id);
      const addedIds = [...wanted].filter((id) => !previous.has(id));
      if (removedIds.length > 0)
        await transaction
          .deleteFrom('channel_members')
          .where('user_id', '=', userId)
          .where('channel_id', 'in', removedIds)
          .execute();
      if (addedIds.length > 0) {
        await transaction
          .insertInto('channel_members')
          .values(addedIds.map((id) => ({ channel_id: id, user_id: userId, joined_at: at })))
          .execute();
        await beginReadScopes(transaction, addedIds, [userId], at);
      }
      if (resetHistory && wanted.size > 0) {
        const retained = [...wanted];
        await transaction
          .updateTable('channel_members')
          .set({
            joined_at: at,
            last_read_message_id: null,
            unread_count: 0,
            unread_mention_count: 0,
            state_version: sql`state_version + 1`,
          })
          .where('user_id', '=', userId)
          .where('channel_id', 'in', retained)
          .execute();
        await transaction
          .deleteFrom('channel_read_scopes')
          .where('user_id', '=', userId)
          .where('channel_id', 'in', retained)
          .execute();
        await beginReadScopes(transaction, retained, [userId], at);
      }
      const visible = await grants(transaction, current, userId);
      return {
        visibleIds: visible.filter((row) => row.visible).map((row) => row.id),
        hiddenCount: visible.filter((row) => !row.visible).length,
        previousIds: latest.map((row) => row.id),
        removedIds,
        addedCount: addedIds.length,
        changed: addedIds.length > 0 || removedIds.length > 0 || resetHistory,
      };
    },
  };
};
