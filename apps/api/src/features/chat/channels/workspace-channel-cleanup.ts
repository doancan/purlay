/** Conversation and departure cleanup stays authoritative for expired guests and fresh admissions. */
import { tableExists } from '@purlay/db';
import type { ChatDb } from '../schema';
import { visibleChannels } from './guard';

export const forgetWorkspaceChannels = async (
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
      : // Revocation lists the departing person's topics; it cannot borrow their native session
        // or require them to satisfy a policy before their access can be removed.
        (
          await visibleChannels(executor, userId, { visibilityOnly: true })
            .select('channels.id')
            .where('channels.workspace_id', '=', workspaceId)
            .execute()
        ).map((row) => row.id);
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
