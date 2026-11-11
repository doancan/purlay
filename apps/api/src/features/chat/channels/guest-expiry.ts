/** Retention of expired guests' pending attention; assignments remain available for explicit renewal. */
import { sql, type RawBuilder } from '@purlay/db';
import type { ChatDb, ChatTx } from '../schema';
import { atomicallyOn } from '../../../platform/transactions';

const GUEST_BATCH = 100;
const CHILD_BATCH = 100;
const NOTICE_BATCH = 500;
const CHANNEL_BATCH = 20;

interface Counts {
  guests: number;
  scheduled: number;
  reservations: number;
  reminders: number;
  notifications: number;
  channels: number;
  deferred: number;
}
const nothing = (): Counts => ({
  guests: 0,
  scheduled: 0,
  reservations: 0,
  reminders: 0,
  notifications: 0,
  channels: 0,
  deferred: 0,
});

/** Existing rows are the durable queue, including anything committed after an earlier sweep. */
const pendingAttention = (): RawBuilder<boolean> => sql<boolean>`
  exists (select 1 from scheduled_messages as draft
    where draft.workspace_id = workspace_members.workspace_id and draft.user_id = workspace_members.user_id
      and (draft.state = 'pending' or exists (select 1 from scheduled_message_attachments as reserved
        where reserved.scheduled_message_id = draft.id and reserved.workspace_id = draft.workspace_id)))
  or exists (select 1 from message_reminders as reminder
    where reminder.workspace_id = workspace_members.workspace_id and reminder.user_id = workspace_members.user_id)
  or exists (select 1 from notifications as notice
    where notice.workspace_id = workspace_members.workspace_id and notice.user_id = workspace_members.user_id)
  or exists (select 1 from channel_members as member join channels as channel on channel.id = member.channel_id
    where channel.workspace_id = workspace_members.workspace_id and member.user_id = workspace_members.user_id
      and (member.unread_count <> 0 or member.unread_mention_count <> 0))`;

const cleanOne = async (
  tx: ChatTx,
  candidate: { readonly id: string; readonly workspace_id: string; readonly user_id: string },
): Promise<Counts> => {
  const { workspace_id: workspaceId, user_id: userId } = candidate;
  // Delivery claims a child before looking at membership. Never hold a parent while waiting for it.
  const schedules = await tx
    .selectFrom('scheduled_messages')
    .select(['id', 'state'])
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .where((eb) =>
      eb.or([
        eb('state', '=', 'pending'),
        eb.exists(
          eb
            .selectFrom('scheduled_message_attachments')
            .select('attachment_id')
            .whereRef('scheduled_message_id', '=', 'scheduled_messages.id')
            .whereRef('workspace_id', '=', 'scheduled_messages.workspace_id'),
        ),
      ]),
    )
    .orderBy('id')
    .limit(CHILD_BATCH)
    .forUpdate()
    .skipLocked()
    .execute();
  const scheduleIds = schedules.map((row) => row.id);
  const reservations =
    scheduleIds.length === 0
      ? []
      : await tx
          .selectFrom('scheduled_message_attachments')
          .select('attachment_id')
          .where('workspace_id', '=', workspaceId)
          .where('scheduled_message_id', 'in', scheduleIds)
          .orderBy('attachment_id')
          .limit(CHILD_BATCH)
          .forUpdate()
          .skipLocked()
          .execute();
  const files =
    reservations.length === 0
      ? []
      : await tx
          .selectFrom('attachments')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where(
            'id',
            'in',
            reservations.map((row) => row.attachment_id),
          )
          .orderBy('id')
          .limit(CHILD_BATCH)
          .forUpdate()
          .skipLocked()
          .execute();
  const reminders = await tx
    .selectFrom('message_reminders')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .orderBy('id')
    .limit(CHILD_BATCH)
    .forUpdate()
    .skipLocked()
    .execute();
  const notifications = await tx
    .selectFrom('notifications')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .orderBy('id')
    .limit(NOTICE_BATCH)
    .forUpdate()
    .skipLocked()
    .execute();
  const counters = await tx
    .selectFrom('channel_members')
    .select('channel_id')
    .where('user_id', '=', userId)
    .where('channel_id', 'in', (eb) =>
      eb.selectFrom('channels').select('id').where('workspace_id', '=', workspaceId),
    )
    .where((eb) => eb.or([eb('unread_count', '<>', 0), eb('unread_mention_count', '<>', 0)]))
    .orderBy('channel_id')
    .limit(CHANNEL_BATCH)
    .forUpdate()
    .skipLocked()
    .execute();
  const outcome = nothing();
  // Scope editors lock the workspace before membership. Skipping is essential when they already
  // hold that mutex and are waiting for a child we claimed above; the next sweep retries the rows.
  const workspace = await tx
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .forNoKeyUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (workspace === undefined) return { ...outcome, deferred: 1 };
  const current = await tx
    .selectFrom('workspace_members')
    .select('id')
    .where('id', '=', candidate.id)
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .where('access_kind', '=', 'guest')
    .where('guest_expires_at', '<=', sql<Date>`statement_timestamp()`)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (current === undefined) return { ...outcome, deferred: 1 };
  outcome.guests = 1;
  const pendingIds = schedules.filter((row) => row.state === 'pending').map((row) => row.id);
  if (pendingIds.length > 0) {
    const changed = await tx
      .updateTable('scheduled_messages')
      .set({
        state: 'failed',
        failure_code: 'WORKSPACE_NOT_FOUND',
        updated_at: sql<Date>`statement_timestamp()`,
      })
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .where('id', 'in', pendingIds)
      .where('state', '=', 'pending')
      .executeTakeFirst();
    outcome.scheduled = Number(changed.numUpdatedRows);
  }
  if (files.length > 0) {
    // Only reservations and attachments claimed above: the release trigger can acquire no new file lock.
    const released = await tx
      .deleteFrom('scheduled_message_attachments')
      .where('workspace_id', '=', workspaceId)
      .where('scheduled_message_id', 'in', scheduleIds)
      .where(
        'attachment_id',
        'in',
        files.map((row) => row.id),
      )
      .executeTakeFirst();
    outcome.reservations = Number(released.numDeletedRows);
  }
  if (reminders.length > 0) {
    const removed = await tx
      .deleteFrom('message_reminders')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .where(
        'id',
        'in',
        reminders.map((row) => row.id),
      )
      .executeTakeFirst();
    outcome.reminders = Number(removed.numDeletedRows);
  }
  if (notifications.length > 0) {
    const removed = await tx
      .deleteFrom('notifications')
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .where(
        'id',
        'in',
        notifications.map((row) => row.id),
      )
      .executeTakeFirst();
    outcome.notifications = Number(removed.numDeletedRows);
  }
  if (counters.length > 0) {
    const changed = await tx
      .updateTable('channel_members')
      .set({
        unread_count: 0,
        unread_mention_count: 0,
        state_version: sql<number>`state_version + 1`,
      })
      .where('user_id', '=', userId)
      .where(
        'channel_id',
        'in',
        counters.map((row) => row.channel_id),
      )
      .executeTakeFirst();
    outcome.channels = Number(changed.numUpdatedRows);
  }
  const remaining = await tx
    .selectFrom('workspace_members')
    .select('id')
    .where('id', '=', candidate.id)
    .where(pendingAttention())
    .executeTakeFirst();
  if (remaining !== undefined) outcome.deferred = 1;
  return outcome;
};

export const sweepExpiredGuests = async ({
  database,
}: {
  readonly database: ChatDb;
}): Promise<Counts> => {
  const candidates = await database
    .selectFrom('workspace_members')
    .select(['id', 'workspace_id', 'user_id'])
    .where('access_kind', '=', 'guest')
    .where('guest_expires_at', '<=', sql<Date>`statement_timestamp()`)
    .where(pendingAttention())
    .orderBy('guest_expires_at')
    .orderBy('workspace_id')
    .orderBy('user_id')
    .limit(GUEST_BATCH)
    .execute();
  const total = nothing();
  for (const candidate of candidates) {
    const outcome = await atomicallyOn(database)(async (tx) => await cleanOne(tx, candidate));
    for (const key of Object.keys(total) as (keyof Counts)[]) total[key] += outcome[key];
  }
  return total;
};
