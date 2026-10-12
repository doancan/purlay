/**
 * What a member is told about in a channel (D-107): `all`, `mentions` (the default) or `none`.
 *
 * Only the member's own row, and only a member: a public channel the person can see but has not
 * joined has no membership to set, and is refused with the answer a stranger gets — the read
 * position's rule (D-99 §4), for the same reason. From the next message on: what was already told
 * stays told, and a badge is lowered by reading, not by muting.
 */
import type { Executor } from '@purlay/db';
import type { NotificationLevel } from '@purlay/types';
import { channelNotFound, type ChannelContext } from '../../platform/channels';

export const setNotificationLevel = async (
  executor: Executor,
  context: ChannelContext,
  level: NotificationLevel,
): Promise<void> => {
  const set = await executor
    .updateTable('channel_members')
    .set({ notification_level: level })
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .returning('user_id')
    .executeTakeFirst();
  if (set === undefined) throw channelNotFound();
};
