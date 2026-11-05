/**
 * What chat tells the push sender about a message (D-250, `modules/push/notices.ts`): the notifications it wrote for
 * the people it told, with the channel they are in and who wrote the message.
 */
import { sql } from '@purlay/db';
import { NEEDS_YOU } from '@purlay/types';
import type { PushNotices } from '../../../modules/push/notices';

export const chatPushNotices: PushNotices = {
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
