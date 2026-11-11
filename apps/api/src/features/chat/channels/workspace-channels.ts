/**
 * Chat's answer to what the workspace code asks of a workspace's channels (D-250): who could see what, who
 * leaves which, and how long they are kept. The queries are the ones the workspace code ran itself before it
 * stopped naming chat's tables.
 */
import type { ChatDb } from '../schema';
import type { WorkspaceContext } from '../../../platform/tenancy';
import { forgetWorkspaceChannels } from './workspace-channel-cleanup';
import type { WorkspaceChannels } from '../../../modules/workspaces/channels-port';
import { chatGuestChannels } from './guest-grants';

export const chatWorkspaceChannels: WorkspaceChannels = {
  guests: chatGuestChannels,
  leaveAll: forgetWorkspaceChannels,

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
