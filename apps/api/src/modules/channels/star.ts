/**
 * A person's starred channels (#489, D-132): a channel kept in a section of its own above the rest.
 *
 * Only the member's own row, and only a member: a public channel the person can see but has not
 * joined has no membership to star, and is refused with the answer a stranger gets — the
 * notification level's rule (D-107), for the same reason. Starring what is starred, or letting go
 * of what is not, changes nothing and says so, so nobody is told.
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { channelNotFound, type ChannelContext } from '../../platform/channels';

/** Whether the star changed: false when it was already as asked. */
export const setStarred = async (
  executor: Executor,
  clock: Clock,
  context: ChannelContext,
  starred: boolean,
): Promise<boolean> => {
  const member = await executor
    .selectFrom('channel_members')
    .select('starred_at')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .executeTakeFirst();
  if (member === undefined) throw channelNotFound();
  if ((member.starred_at !== null) === starred) return false;
  await executor
    .updateTable('channel_members')
    .set({ starred_at: starred ? clock.now() : null })
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .execute();
  return true;
};
