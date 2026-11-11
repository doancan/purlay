/** Applied after the canonical channel joins, using a record's trusted stored share time. */
import { sql, type RawBuilder } from '@purlay/db';

export const guestContentHistory = (
  sharedAt: RawBuilder<Date>,
): RawBuilder<boolean> => sql<boolean>`(
  workspace_members.access_kind = 'member'
  or ${sharedAt} >= greatest(workspace_members.guest_since, channel_members.joined_at)
)`;

export const guestMessageHistoryFor = (message = 'messages'): RawBuilder<boolean> =>
  guestContentHistory(sql.ref<Date>(`${message}.created_at`));

export const guestMessageHistory = guestMessageHistoryFor();

/** A thread container is discoverable through a readable reply; this never grants its content. */
export const guestThreadHistoryFor = (message = 'messages'): RawBuilder<boolean> => sql<boolean>`(
  ${guestMessageHistoryFor(message)}
  or (${sql.ref(`${message}.parent_id`)} is null and exists (
    select 1 from messages as readable_thread_reply
    where readable_thread_reply.parent_id = ${sql.ref(`${message}.id`)}
      and readable_thread_reply.channel_id = ${sql.ref(`${message}.channel_id`)}
      and ${guestMessageHistoryFor('readable_thread_reply')}
  ))
)`;
