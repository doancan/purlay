/**
 * Chat's answer to what the workspace code asks of a workspace's channels (D-250): who could see what, who
 * leaves which, and how long they are kept. The queries are the ones the workspace code ran itself before it
 * stopped naming chat's tables.
 */
import { tableExists } from '@purlay/db';
import type { ChatDb } from '../schema';
import { visibleChannelIds } from './guard';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../../platform/tenancy';
import type { WorkspaceChannels } from '../../../modules/workspaces/channels-port';
import { chatGuestChannels } from './guest-grants';

const leaveAll = async (
  executor: ChatDb,
  workspaceId: string,
  userId: string,
): Promise<readonly string[]> => {
  const membership = await executor
    .selectFrom('workspace_members')
    .select('access_kind')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  // Expiry denies reading; it must not prevent the administrator or expiry worker from revoking the rows.
  const channelIds =
    membership?.access_kind === 'guest'
      ? (
          await executor
            .selectFrom('channel_members')
            .innerJoin('channels', 'channels.id', 'channel_members.channel_id')
            .select('channel_members.channel_id')
            .where('channels.workspace_id', '=', workspaceId)
            .where('channel_members.user_id', '=', userId)
            .orderBy('channel_members.channel_id')
            .execute()
        ).map((row) => row.channel_id)
      : await visibleChannelIds(
          executor,
          await requireWorkspaceMembership(executor, userId, workspaceId),
        );
  await executor
    .deleteFrom('channel_members')
    .where('user_id', '=', userId)
    .where('channel_id', 'in', (eb) =>
      eb.selectFrom('channels').select('id').where('workspace_id', '=', workspaceId),
    )
    .execute();
  // Out of the workspace, not out of a channel: no reason is kept to be told later (D-264). Made by chat's own set, so
  // absent where it was never applied; this runs whether chat does or not, and there is then nothing to forget.
  if (await tableExists(executor, 'channel_departures')) {
    await executor
      .deleteFrom('channel_departures')
      .where('user_id', '=', userId)
      .where('channel_id', 'in', (eb) =>
        eb.selectFrom('channels').select('id').where('workspace_id', '=', workspaceId),
      )
      .execute();
  }
  return channelIds;
};

export const chatWorkspaceChannels: WorkspaceChannels = {
  guests: chatGuestChannels,
  leaveAll,

  keptLonger: async (executor: ChatDb, context: WorkspaceContext, retentionDays: number | null) => {
    if (retentionDays === null) return 0;
    const row = await executor
      .selectFrom('channels')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('workspace_id', '=', context.workspaceId)
      .where((eb) =>
        eb.or([eb('retain_forever', '=', true), eb('min_retention_days', '>', retentionDays)]),
      )
      .executeTakeFirstOrThrow();
    return Number(row.count);
  },

  idsIn: async (executor: ChatDb, workspaceId: string) =>
    (
      await executor
        .selectFrom('channels')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .execute()
    ).map((channel) => channel.id),
};
