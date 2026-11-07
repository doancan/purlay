/**
 * A person's starred channels (#489, D-132): a channel kept in a section of its own above the rest.
 *
 * Only the member's own row, and only a member: a public channel the person can see but has not
 * joined has no membership to star, and is refused with the answer a stranger gets — the
 * notification level's rule (D-107), for the same reason. A conversation is not a channel to star:
 * its people are found under People and Conversations, and it is refused the same way.
 *
 * The transaction locks the membership before clearing a group and changing its star. It changes only when needed, so two
 * tabs starring at once write once and tell once. Starring what is starred, or letting go of what
 * is not, changes nothing and says so, so nobody is told.
 */
import type { ChatTx } from '../schema';
import type { Clock } from '../../../platform/clock';
import { channelNotFound, type ChannelContext } from './guard';

/** Whether the star changed: false when it was already as asked. */
export const setStarred = async (
  executor: ChatTx,
  clock: Clock,
  context: ChannelContext,
  starred: boolean,
): Promise<boolean> => {
  if (context.channelType === 'direct_message') throw channelNotFound();
  const member = await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .forUpdate()
    .executeTakeFirst();
  if (member === undefined) throw channelNotFound();
  const placement = starred
    ? await executor
        .deleteFrom('channel_group_channels')
        .where('channel_id', '=', context.channelId)
        .where('user_id', '=', context.userId)
        .returning('channel_id')
        .executeTakeFirst()
    : undefined;
  const changed = await executor
    .updateTable('channel_members')
    .set({ starred_at: starred ? clock.now() : null })
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .where('starred_at', starred ? 'is' : 'is not', null)
    .returning('user_id')
    .executeTakeFirst();
  return changed !== undefined || placement !== undefined;
};
