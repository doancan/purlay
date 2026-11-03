/**
 * Chat's answer to what the workspace code asks of a workspace's channels (D-250): who could see what, who
 * leaves which, and how long they are kept. The queries are the ones the workspace code ran itself before it
 * stopped naming chat's tables.
 */
import type { Executor } from '@purlay/db';
import { visibleChannelIds } from '../../../platform/channels';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../../platform/tenancy';
import type { WorkspaceChannels } from '../../../modules/workspaces/channels-port';

export const chatWorkspaceChannels: WorkspaceChannels = {
  leaveAll: async (executor: Executor, workspaceId: string, userId: string) => {
    const theirs = await requireWorkspaceMembership(executor, userId, workspaceId);
    const channelIds = await visibleChannelIds(executor, theirs);
    await executor
      .deleteFrom('channel_members')
      .where('user_id', '=', userId)
      .where('channel_id', 'in', (eb) =>
        eb.selectFrom('channels').select('id').where('workspace_id', '=', workspaceId),
      )
      .execute();
    return channelIds;
  },

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
