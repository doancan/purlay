/**
 * What chat tells the push sender about a message (D-250, `modules/push/notices.ts`): the notifications it wrote for
 * the people it told, with the channel they are in and who wrote the message.
 */
import { sql, type RawBuilder } from '@purlay/db';
import { NEEDS_YOU } from '@purlay/types';
import type { PushNotices } from '../../../modules/push/notices';
import { AppError } from '../../../platform/errors';
import { channelAudienceQuery, requireMessageById } from '../channels/guard';
import { notHiddenBy } from '../messages/hidden';
import { levelInForce } from '../channels/notification-level';
import type { ChatDb } from '../schema';

/** Match the original receipt and its current audience. The scheduler retains its row through the last slot. */
const repeatNotice = (executor: ChatDb, now?: Date): RawBuilder<boolean> => {
  const person = sql.ref<string>('n.user_id');
  const message = sql.ref<string>('n.message_id');
  const channel = sql.ref<string>('n.channel_id');
  const eligible = executor
    .selectFrom('urgent_message_repeats as repeat')
    .innerJoin('messages as source', (join) =>
      join
        .on('source.id', '=', message)
        .on('source.channel_id', '=', channel)
        .on('source.workspace_id', '=', sql.ref<string>('n.workspace_id')),
    )
    .innerJoin('channels as channel', 'channel.id', 'source.channel_id')
    .innerJoin('workspaces as workspace', 'workspace.id', 'source.workspace_id')
    .select('repeat.notification_id')
    .where('repeat.notification_id', '=', sql.ref<string>('n.id'))
    .where('source.priority', '=', 'urgent')
    .where('workspace.urgent_messages_enabled', '=', true)
    .where('source.sender_id', '<>', person)
    .where((eb) =>
      eb.or([
        eb.and([
          eb('channel.type', '=', 'direct_message'),
          eb(sql.ref('n.type'), 'in', ['mention', 'direct_message']),
        ]),
        eb.and([
          eb(sql.ref('n.type'), '=', 'mention'),
          eb.exists(
            eb
              .selectFrom('mentions')
              .select('mentions.id')
              .whereRef('mentions.message_id', '=', 'source.id')
              .where('mentions.mentioned_user_id', '=', person),
          ),
        ]),
      ]),
    )
    .where((eb) =>
      eb.exists(channelAudienceQuery(executor, channel, message).where('users.id', '=', person)),
    );
  const notice =
    now === undefined
      ? eligible
      : eligible.where(
          sql.ref<Date>('n.created_at'),
          '>',
          new Date(now.getTime() - URGENT_REPEAT_WINDOW_MS),
        );
  return sql<boolean>`exists (${notice})`;
};

export const URGENT_REPEAT_WINDOW_MS = 20 * 60_000;

export const chatPushNotices: PushNotices = {
  canDeliver: async (executor, messageId, userId, now, notificationId, repeat) => {
    if (repeat === true && notificationId === undefined) return false;
    try {
      let channelId: string | undefined;
      let admissionFailure: AppError | undefined;
      try {
        channelId = (await requireMessageById(executor, userId, messageId)).context.channelId;
      } catch (error) {
        // The scheduler checks repeat eligibility without a device session, so defer an admission
        // refusal until the final receipt check. A device's authority still has to admit it.
        if (!(
          repeat === true &&
          error instanceof AppError &&
          error.body.code === 'WORKSPACE_ACCESS_REQUIRED'
        ))
          throw error;
        admissionFailure = error;
      }
      const candidate = await executor
        .selectFrom('notifications as n')
        .innerJoin('users as person', 'person.id', 'n.user_id')
        .leftJoin('channel_members as member', (join) =>
          join
            .onRef('member.channel_id', '=', 'n.channel_id')
            .onRef('member.user_id', '=', 'n.user_id'),
        )
        // The level in force as the push goes, not as it was queued (D-329).
        .leftJoin('channel_level_timers as level_timer', (join) =>
          join
            .onRef('level_timer.channel_id', '=', 'member.channel_id')
            .onRef('level_timer.user_id', '=', 'member.user_id'),
        )
        .select('n.id')
        .where('n.message_id', '=', messageId)
        .where((eb) =>
          channelId === undefined ? eb.val(true) : eb('n.channel_id', '=', channelId),
        )
        .where('n.user_id', '=', userId)
        .where((eb) =>
          notificationId === undefined ? eb.val(true) : eb('n.id', '=', notificationId),
        )
        .where('n.type', 'in', [...NEEDS_YOU, 'reminder'])
        .where('n.read_at', 'is', null)
        .$if(repeat !== true, (query) => query.where('n.suppressed_by_deep_work', '=', false))
        .$if(repeat === true, (query) => query.where(repeatNotice(executor, now)))
        .where('person.deleted_at', 'is', null)
        .where('person.suspended_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb(levelInForce('member', 'level_timer', now), 'is', null),
            eb(levelInForce('member', 'level_timer', now), '<>', 'none'),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb('n.type', '<>', 'channel_message'),
            eb(levelInForce('member', 'level_timer', now), '=', 'all'),
          ]),
        )
        .where(notHiddenBy(userId, sql.ref('n.message_id')))
        .executeTakeFirst();
      if (candidate === undefined) return false;
      if (admissionFailure !== undefined) throw admissionFailure;
      return true;
    } catch (error) {
      if (error instanceof AppError && error.body.code === 'MESSAGE_NOT_FOUND') return false;
      throw error;
    }
  },
  of: async (executor, messageId, userIds, notificationId, repeat) => {
    if (repeat === true && notificationId === undefined) return [];
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
        'm.priority',
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
      .where((eb) =>
        notificationId === undefined ? eb.val(true) : eb('n.id', '=', notificationId),
      )
      .where('n.type', 'in', [...NEEDS_YOU, 'reminder'])
      .where('n.read_at', 'is', null)
      .$if(repeat !== true, (query) => query.where('n.suppressed_by_deep_work', '=', false))
      .$if(repeat === true, (query) =>
        query
          .where(repeatNotice(executor))
          .where(notHiddenBy(sql.ref('n.user_id'), sql.ref('n.message_id'))),
      )
      .where('m.deleted_at', 'is', null)
      .execute();
    return rows.map(({ priority, ...notice }) => ({
      ...notice,
      ...(priority === 'important' || priority === 'urgent' ? { priority } : {}),
    }));
  },
};
