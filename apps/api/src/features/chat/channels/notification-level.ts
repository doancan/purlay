/**
 * What a member is told about in a channel (D-107): `all`, `mentions` (the default) or `none` — for good, or for a
 * while (D-329).
 *
 * Only the member's own row, and only a member: a public channel the person can see but has not
 * joined has no membership to set, and is refused with the answer a stranger gets — the read
 * position's rule (D-99 §4), for the same reason. From the next message on: what was already told
 * stays told, and a badge is lowered by reading, not by muting.
 *
 * **A level for a while ends by itself, as Deep Work does (D-108).** Its end and the level it gives way to are kept
 * beside the membership (`channel_level_timers`); every reader of the level asks `levelInForce` at its own instant,
 * so no job has to run when it ends and no node can miss the moment. A row past its end is only history: the level
 * it gave way to is the one in force, until the person chooses again.
 */
import { sql, type RawBuilder } from '@purlay/db';
import { DEEP_WORK_MAX_HOURS, type NotificationLevel } from '@purlay/types';
import type { ChatTx } from '../schema';
import type { Clock } from '../../../platform/clock';
import { requireEndAhead } from '../../../platform/ends-ahead';
import { channelNotFound, type ChannelContext } from './guard';

/**
 * The level in force at `now` for a membership row aliased `member`, with its timer left-joined as `timer`: the
 * level it was set to, or — once a level set for a while has ended — the one it gave way to. Null where `member`
 * is (no membership).
 */
export const levelInForce = (
  member: string,
  timer: string,
  now: Date,
): RawBuilder<NotificationLevel | null> =>
  sql<NotificationLevel | null>`(case when ${sql.ref(`${timer}.ends_at`)} <= ${now}
    then ${sql.ref(`${timer}.then_level`)} else ${sql.ref(`${member}.notification_level`)} end)`;

/** Until when the level in force lasts, for a timer left-joined as `timer`: null for good, or when it has ended. */
export const levelInForceUntil = (timer: string, now: Date): RawBuilder<Date | string | null> =>
  sql<Date | string | null>`(case when ${sql.ref(`${timer}.ends_at`)} > ${now}
    then ${sql.ref(`${timer}.ends_at`)} end)`;

/**
 * Sets the member's own level, for good or until `until` — within Deep Work's bound, `DEEP_WORK_MAX_HOURS` — after
 * which the level in force before it returns. A level for a while chosen while another lasts keeps the level that
 * was there before either: muting again for longer still comes back to what the person had.
 */
export const setNotificationLevel = async (
  transaction: ChatTx,
  clock: Clock,
  context: ChannelContext,
  level: NotificationLevel,
  until?: string,
): Promise<void> => {
  const endsAt =
    until === undefined
      ? null
      : requireEndAhead(clock, until, DEEP_WORK_MAX_HOURS, 'A level for a while');
  const now = clock.now();
  // The row locked first, so two tabs choosing at once are taken one after the other and the second reads what the
  // first left — never a level to return to that is the first one's mute.
  const current = await transaction
    .selectFrom('channel_members as member')
    .leftJoin('channel_level_timers as timer', (join) =>
      join
        .onRef('timer.channel_id', '=', 'member.channel_id')
        .onRef('timer.user_id', '=', 'member.user_id'),
    )
    .select([
      levelInForce('member', 'timer', now).as('level'),
      levelInForceUntil('timer', now).as('until'),
      'timer.then_level',
    ])
    .where('member.channel_id', '=', context.channelId)
    .where('member.user_id', '=', context.userId)
    .forUpdate('member')
    .executeTakeFirst();
  if (current === undefined || current.level === null) throw channelNotFound();
  await transaction
    .updateTable('channel_members')
    .set({ notification_level: level })
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', context.userId)
    .execute();
  if (endsAt === null) {
    await transaction
      .deleteFrom('channel_level_timers')
      .where('channel_id', '=', context.channelId)
      .where('user_id', '=', context.userId)
      .execute();
    return;
  }
  const thenLevel =
    current.until !== null && current.then_level !== null ? current.then_level : current.level;
  await transaction
    .insertInto('channel_level_timers')
    .values({
      channel_id: context.channelId,
      user_id: context.userId,
      ends_at: endsAt,
      then_level: thenLevel,
    })
    .onConflict((conflict) =>
      conflict
        .columns(['channel_id', 'user_id'])
        .doUpdateSet({ ends_at: endsAt, then_level: thenLevel }),
    )
    .execute();
};
