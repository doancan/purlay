/**
 * What chat tells the push sender about a message (D-250, `modules/push/notices.ts`): the notifications it wrote for
 * the people it told, with the channel they are in and who wrote the message.
 */
import { sql } from '@purlay/db';
import { NEEDS_YOU } from '@purlay/types';
import type { PushNotices } from '../../../modules/push/notices';
import { AppError } from '../../../platform/errors';
import { requireMessageById } from '../channels/guard';
import { notHiddenBy } from '../messages/hidden';

export const chatPushNotices: PushNotices = {
  canDeliver: async (executor, messageId, userId) => {
    try {
      const { context } = await requireMessageById(executor, userId, messageId);
      return (
        (await executor
          .selectFrom('notifications as n')
          .innerJoin('users as person', 'person.id', 'n.user_id')
          .leftJoin('channel_members as member', (join) =>
            join
              .onRef('member.channel_id', '=', 'n.channel_id')
              .onRef('member.user_id', '=', 'n.user_id'),
          )
          .select('n.id')
          .where('n.message_id', '=', messageId)
          .where('n.channel_id', '=', context.channelId)
          .where('n.user_id', '=', userId)
          .where('n.type', 'in', [...NEEDS_YOU, 'reminder'])
          .where('n.read_at', 'is', null)
          .where('n.suppressed_by_deep_work', '=', false)
          .where('person.deleted_at', 'is', null)
          .where('person.suspended_at', 'is', null)
          .where((eb) =>
            eb.or([
              eb('member.notification_level', 'is', null),
              eb('member.notification_level', '<>', 'none'),
            ]),
          )
          .where((eb) =>
            eb.or([
              eb('n.type', '<>', 'channel_message'),
              eb('member.notification_level', '=', 'all'),
            ]),
          )
          .where(notHiddenBy(userId, sql.ref('n.message_id')))
          .executeTakeFirst()) !== undefined
      );
    } catch (error) {
      if (error instanceof AppError && error.body.code === 'MESSAGE_NOT_FOUND') return false;
      throw error;
    }
  },
  of: async (executor, messageId, userIds) => {
    const rows = await executor
      .selectFrom('notifications as n')
      .innerJoin('messages as m', 'm.id', 'n.message_id')
      .innerJoin('users as author', 'author.id', 'm.sender_id')
      .innerJoin('channels as c', 'c.id', 'n.channel_id')
      // A reply's root: whose thread it is decides what the reply is said as (D-162).
      .leftJoin('messages as root', 'root.id', 'm.parent_id')
      .select([
        'n.user_id as userId',
        'n.type',
        'n.channel_id as channelId',
        'n.workspace_id as workspaceId',
        'c.name as channelName',
        'author.display_name as authorName',
        'root.sender_id as rootSenderId',
        sql<
          string | null
        >`coalesce(m.parent_id, case when n.type = 'thread_reply' then m.id end)`.as('threadId'),
        // A group's people besides the one told, by name: what its notice is titled (D-127).
        sql<string | null>`(
          select string_agg(other.display_name, ', ' order by key_part.place)
          from unnest(string_to_array(c.dm_key, ':')) with ordinality as key_part(id, place)
          join users as other on other.id = key_part.id::uuid
          where cardinality(string_to_array(c.dm_key, ':')) > 2 and other.id <> n.user_id
        )`.as('groupNames'),
      ])
      .where('n.message_id', '=', messageId)
      .where('n.user_id', 'in', userIds)
      .where('n.type', 'in', [...NEEDS_YOU, 'reminder'])
      .where('n.read_at', 'is', null)
      .where('n.suppressed_by_deep_work', '=', false)
      .where('m.deleted_at', 'is', null)
      .execute();
    return rows;
  },
};
