/** Applied after the canonical channel joins, wherever an individual message supplies authority. */
import { sql, type RawBuilder } from '@purlay/db';

export const guestMessageHistoryFor = (message = 'messages'): RawBuilder<boolean> => sql<boolean>`(
  workspace_members.access_kind = 'member'
  or ${sql.ref(`${message}.created_at`)} >= greatest(workspace_members.guest_since, channel_members.joined_at)
)`;

export const guestMessageHistory = guestMessageHistoryFor();
