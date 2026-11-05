/**
 * Chat's answer to what the workspace code asks of a workspace's channels (D-250): who could see what, who
 * leaves which, and how long they are kept. The queries are the ones the workspace code ran itself before it
 * stopped naming chat's tables.
 */
import { tableExists, type Executor } from '@purlay/db';
import { visibleChannelIds } from './guard';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../../platform/tenancy';
import type { WorkspaceChannels } from '../../../modules/workspaces/channels-port';

const leaveAll = async (
  executor: Executor,
  workspaceId: string,
  userId: string,
): Promise<readonly string[]> => {
  const theirs = await requireWorkspaceMembership(executor, userId, workspaceId);
  const channelIds = await visibleChannelIds(executor, theirs);
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
  leaveAll,

  keptLonger: async (
    executor: Executor,
    context: WorkspaceContext,
    retentionDays: number | null,
  ) => {
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

  idsIn: async (executor: Executor, workspaceId: string) =>
    (
      await executor
        .selectFrom('channels')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .execute()
    ).map((channel) => channel.id),
};
