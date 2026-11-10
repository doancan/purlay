/** The same unread rule for catch-up reads, counter recounts and counter writers (D-282). */
import { sql, type RawBuilder } from '@purlay/db';
import { NEEDS_YOU } from '@purlay/types';
import { notHiddenBy } from '../messages/hidden';

type Id = string | RawBuilder<unknown>;

/** Before every application-generated UUIDv7 message, for conservatively activated legacy scopes. */
export const HISTORY_BEGINNING = '1970-01-01T00:00:00.000Z';

export interface ReadScope {
  /** Guest authority is independent of an explicitly reopened unread range. */
  readonly historyFloor?: Date | string | RawBuilder<unknown> | null;
  readonly userId: Id;
  readonly position: Id | null;
  readonly threadBaseline: Id | null;
  /** Explicitly reopened UUID range, in addition to messages delivered after the join. */
  readonly historyFrom?: Id | null;
  /** NULL is a legacy unknown scope, made explicit on its first read recount. */
  readonly since: Date | string | RawBuilder<unknown> | null;
}

const withinHistory = (scope: ReadScope, message: string): RawBuilder<boolean> =>
  scope.historyFloor === undefined || scope.historyFloor === null
    ? sql<boolean>`true`
    : sql<boolean>`${sql.ref(`${message}.created_at`)} >= coalesce(${scope.historyFloor}::timestamptz, '-infinity'::timestamptz)`;

/** Whether the two positions leave this message waiting, before a notification asks again. */
const unreadPosition = (scope: ReadScope, message: string): RawBuilder<boolean> => sql<boolean>`(
  ((${scope.since}::timestamptz is null or ${sql.ref(`${message}.created_at`)} >= ${scope.since})
    or (${scope.historyFrom ?? null}::uuid is not null and ${sql.ref(`${message}.id`)} >= ${scope.historyFrom ?? null}))
  and (
    (${sql.ref(`${message}.parent_id`)} is null
      and (${scope.position}::uuid is null or ${sql.ref(`${message}.id`)} > ${scope.position}))
    or (${sql.ref(`${message}.parent_id`)} is not null
      and (${scope.threadBaseline}::uuid is null or ${sql.ref(`${message}.id`)} > ${scope.threadBaseline})
      and not exists (
        select 1 from thread_reads r
        where r.channel_id = ${sql.ref(`${message}.channel_id`)} and r.user_id = ${scope.userId}
          and r.root_id = ${sql.ref(`${message}.parent_id`)}
          and r.last_read_message_id >= ${sql.ref(`${message}.id`)}
      )
      and not exists (
        select 1 from notifications acknowledged
        where acknowledged.user_id = ${scope.userId}
          and acknowledged.message_id = ${sql.ref(`${message}.id`)}
          and acknowledged.read_at is not null and acknowledged.type in (${sql.join(NEEDS_YOU)})
          and ${sql.ref(`${message}.id`)} <= ${scope.position}::uuid
      ))
  )
)`;

/** Reading the feed and a thread are independent; a new notification can ask for an old reply again. */
export const unreadCondition = (
  scope: ReadScope,
  message: string,
): RawBuilder<boolean> => sql<boolean>`(
  ${withinHistory(scope, message)} and (${unreadPosition(scope, message)} or (
    ${sql.ref(`${message}.parent_id`)} is not null and exists (
      select 1 from notifications n
      where n.user_id = ${scope.userId} and n.message_id = ${sql.ref(`${message}.id`)}
        and n.read_at is null and n.type in (${sql.join(NEEDS_YOU)})
    )
  ))
)`;

/** Classifies a row even just after deletion/hiding; late mentions can ask what was unread before them. */
export const unreadMessage = (
  scope: ReadScope,
  messageId: Id,
  includeNotifications = true,
): RawBuilder<boolean> => sql<boolean>`exists (
  select 1 from messages unread_message where unread_message.id = ${messageId}
    and ${includeNotifications ? unreadCondition(scope, 'unread_message') : sql<boolean>`${withinHistory(scope, 'unread_message')} and ${unreadPosition(scope, 'unread_message')}`}
)`;

/** Count messages once, including a waiting reply behind either read cursor. */
export const unreadMessages = (scope: ReadScope, channelId: Id): RawBuilder<number> =>
  sql<number>`(
    select count(*)::int from messages m
    where m.channel_id = ${channelId} and m.sender_id is distinct from ${scope.userId}
      and m.deleted_at is null and ${notHiddenBy(scope.userId, sql.ref('m.id'))}
      and ${unreadCondition(scope, 'm')}
  )`;
