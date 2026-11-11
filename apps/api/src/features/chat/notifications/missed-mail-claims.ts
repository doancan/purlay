/** Durable SMTP claim ownership; only the captured letter may restore its marked rows. */
import { atomicallyOn } from '../../../platform/transactions';
import type { ChatDb, ChatTx } from '../schema';

/** Longer than the relay's bounded connection/socket waits; a dead process cannot hold work forever. */
export const MISSED_MAIL_CLAIM_MS = 5 * 60_000;
const RECOVERY_BATCH_MAX = 100;

export const releaseMailClaim = async (
  transaction: ChatTx,
  userId: string,
  letterId: string,
  expiredAt?: Date,
): Promise<boolean> => {
  const person = await transaction
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (person === undefined) return false;
  const letter = await transaction
    .selectFrom('missed_mail_claims as claim')
    .innerJoin('missed_mail_letters as letter', 'letter.id', 'claim.letter_id')
    .select(['claim.notification_ids', 'letter.sent_at'])
    .where('claim.letter_id', '=', letterId)
    .where('letter.user_id', '=', userId)
    .where('claim.lease_until', 'is not', null)
    .$if(expiredAt !== undefined, (query) =>
      query.where('claim.lease_until', '<=', expiredAt ?? new Date(0)),
    )
    .executeTakeFirst();
  if (letter === undefined) return false;
  const released = await transaction
    .updateTable('missed_mail_claims')
    .set({ lease_until: null })
    .where('letter_id', '=', letterId)
    .where('lease_until', 'is not', null)
    .$if(expiredAt !== undefined, (query) =>
      query.where('lease_until', '<=', expiredAt ?? new Date(0)),
    )
    .returning('letter_id')
    .executeTakeFirst();
  if (released === undefined) return false;
  const channels = await transaction
    .selectFrom('notifications')
    .select('channel_id')
    .distinct()
    .where('user_id', '=', userId)
    .where('id', 'in', letter.notification_ids)
    .execute();
  if (channels.length > 0)
    await transaction
      .selectFrom('channel_members')
      .select('channel_id')
      .where('user_id', '=', userId)
      .where(
        'channel_id',
        'in',
        channels.map((row) => row.channel_id),
      )
      .orderBy('channel_id')
      .forUpdate()
      .execute();
  await transaction
    .updateTable('notifications')
    .set({ mailed_at: null })
    .where('user_id', '=', userId)
    .where('id', 'in', letter.notification_ids)
    .where('mailed_at', '=', letter.sent_at)
    .execute();
  return true;
};

/** An old SMTP completion cannot settle a replacement claim after recovery. */
export const settleMailClaim = async (
  transaction: ChatTx,
  userId: string,
  letterId: string,
): Promise<void> => {
  await transaction
    .deleteFrom('missed_mail_claims')
    .where('letter_id', '=', letterId)
    .where('lease_until', 'is not', null)
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom('missed_mail_letters')
          .select('id')
          .where('id', '=', letterId)
          .where('user_id', '=', userId),
      ),
    )
    .execute();
};

/** Bounded, ordered recovery before retention; a dead claim is never purged with its notifications still marked. */
export const recoverMailClaims = async (database: ChatDb, now: Date): Promise<number> => {
  const due = await database
    .selectFrom('missed_mail_claims as claim')
    .innerJoin('missed_mail_letters as letter', 'letter.id', 'claim.letter_id')
    .select(['claim.letter_id', 'letter.user_id'])
    .where('claim.lease_until', '<=', now)
    .orderBy('claim.lease_until')
    .orderBy('claim.letter_id')
    .limit(RECOVERY_BATCH_MAX)
    .execute();
  let recovered = 0;
  for (const row of due) {
    const released = await atomicallyOn(database)(
      async (transaction) => await releaseMailClaim(transaction, row.user_id, row.letter_id, now),
    );
    if (released) recovered++;
  }
  return recovered;
};
