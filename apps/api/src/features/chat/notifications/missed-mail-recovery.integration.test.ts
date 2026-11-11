/** Committed claims survive an actual worker process death, without replaying old authority. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  sql,
  type Executor,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { DAY_MS, fixedClock } from '../../../platform/clock';
import type { MailMessage, SendMail } from '../../../platform/mail';
import { aRoom } from '../../../testing/rooms';
import { aRecordingLogger, NOW } from '../../../testing/doubles';
import { mailMissedMessages, MISSED_MAIL_DELAY_MS, stopMissedMail } from './missed-mail';

import { atomicallyOn } from '../../../platform/transactions';
import { randomToken, tokenDigest } from '../../../platform/tokens';
import {
  MISSED_MAIL_CLAIM_MS,
  recoverMailClaims,
  releaseMailClaim,
  settleMailClaim,
} from './missed-mail-claims';

afterAll(closeIntegrationDatabase);

describe('integration: durable missed-mail recovery', () => {
  test('a fresh worker recovers a committed claim after a real process death and keeps its old stop link', async () => {
    const owned = await cloneIntegrationDatabase();
    const folder = mkdtempSync(join(tmpdir(), 'purlay-mail-crash-'));
    try {
      const room = await aRoom(owned.db, ['writer', 'reader']);
      const userId = room.members['reader']?.userId ?? '';
      const senderId = room.members['writer']?.userId ?? '';
      await owned.db
        .updateTable('users')
        .set({ email_verified: true, missed_mail_since: new Date(NOW.getTime() - DAY_MS) })
        .where('id', '=', userId)
        .execute();
      const created = new Date(NOW.getTime() - MISSED_MAIL_DELAY_MS);
      const id = messageId(created);
      await owned.db
        .insertInto('messages')
        .values({
          id,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          sender_id: senderId,
          created_at: created,
          content: 'Only readable current words',
        })
        .execute();
      await owned.db
        .insertInto('notifications')
        .values({
          user_id: userId,
          workspace_id: room.workspaceId,
          channel_id: room.channelId,
          message_id: id,
          type: 'mention',
          created_at: created,
        })
        .execute();
      const checkpoint = join(folder, 'handed-off.json');
      const script = `
      import { createDatabase } from './packages/db/src/index';
      import { writeFileSync } from 'node:fs';
      import { fixedClock } from './apps/api/src/platform/clock';
      import { NO_LOG } from './apps/api/src/platform/events';
      import { mailMissedMessages } from './apps/api/src/features/chat/notifications/missed-mail';
      const db=createDatabase({connectionString:process.env['DATABASE_URL']});
      await mailMissedMessages({database:db,clock:fixedClock(new Date(process.env['MAIL_CLOCK'])),log:NO_LOG,appUrl:'https://purlay.test',send:async letter=>{
        writeFileSync(process.env['MAIL_CHECKPOINT'],JSON.stringify(letter),{mode:0o600});
        process.exit(86);
      }});
    `;
      const child = Bun.spawn(['bun', '--no-env-file', '-e', script], {
        env: {
          ...process.env,
          DATABASE_URL: owned.connectionString,
          MAIL_CLOCK: NOW.toISOString(),
          MAIL_CHECKPOINT: checkpoint,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await child.exited).toBe(86);
      const attempted = JSON.parse(readFileSync(checkpoint, 'utf8')) as MailMessage;
      const claimed = await owned.db
        .selectFrom('notifications')
        .select('mailed_at')
        .where('message_id', '=', id)
        .executeTakeFirstOrThrow();
      expect(claimed.mailed_at).not.toBeNull();
      const letters: MailMessage[] = [];
      await mailMissedMessages({
        database: owned.db,
        clock: fixedClock(new Date(NOW.getTime() + 6 * 60_000)),
        log: aRecordingLogger().log,
        appUrl: 'https://purlay.test',
        send: (letter) => {
          letters.push(letter);
          return Promise.resolve();
        },
      });
      expect(letters).toHaveLength(1);
      expect(letters[0]?.messageId).toBe(attempted.messageId);
      const token = /\/mail\/stop#([0-9a-f]{64})/.exec(attempted.text)?.[1];
      expect(token).toBeDefined();
      await stopMissedMail(owned.db, fixedClock(NOW), { token: token ?? '' });
      expect(
        (
          await owned.db
            .selectFrom('users')
            .select('missed_mail_since')
            .where('id', '=', userId)
            .executeTakeFirstOrThrow()
        ).missed_mail_since,
      ).toBeNull();
    } finally {
      rmSync(folder, { recursive: true, force: true });
      await owned.drop();
    }
  }, 30_000);

  /** A committed, pending claim without any SMTP or process mock. */
  const waitingClaim = async (
    db: Executor,
    sentAt = NOW,
  ): Promise<{ userId: string; notificationId: string; letterId: string }> => {
    const room = await aRoom(db, ['writer', 'reader']);
    const userId = room.members['reader']?.userId ?? '';
    await db
      .updateTable('users')
      .set({ email_verified: true, missed_mail_since: new Date(NOW.getTime() - DAY_MS) })
      .where('id', '=', userId)
      .execute();
    const created = new Date(NOW.getTime() - MISSED_MAIL_DELAY_MS);
    const id = messageId(created);
    await db
      .insertInto('messages')
      .values({
        id,
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        sender_id: room.members['writer']?.userId ?? '',
        created_at: created,
        content: 'Current readable words',
      })
      .execute();
    const notification = await db
      .insertInto('notifications')
      .values({
        user_id: userId,
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        message_id: id,
        type: 'mention',
        created_at: created,
        mailed_at: sentAt,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const letter = await db
      .insertInto('missed_mail_letters')
      .values({ user_id: userId, sent_at: sentAt, stop_digest: await tokenDigest(randomToken()) })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('missed_mail_claims')
      .values({
        letter_id: letter.id,
        notification_ids: [notification.id],
        lease_until: new Date(sentAt.getTime() + MISSED_MAIL_CLAIM_MS),
      })
      .execute();
    return { userId, notificationId: notification.id, letterId: letter.id };
  };

  const run = async (db: Executor, at: Date, send: SendMail | undefined): Promise<void> => {
    await mailMissedMessages({
      database: db,
      clock: fixedClock(at),
      log: aRecordingLogger().log,
      appUrl: 'https://purlay.test',
      send,
    });
  };

  test('recovery respects the exact lease boundary and a legacy letter still spends its hour', async () => {
    await withRollback(async (db) => {
      const claim = await waitingClaim(db);
      expect(await recoverMailClaims(db, new Date(NOW.getTime() + MISSED_MAIL_CLAIM_MS - 1))).toBe(
        0,
      );
      expect(await recoverMailClaims(db, new Date(NOW.getTime() + MISSED_MAIL_CLAIM_MS))).toBe(1);
      await db.deleteFrom('missed_mail_claims').where('letter_id', '=', claim.letterId).execute();
      let sent = 0;
      await run(db, new Date(NOW.getTime() + MISSED_MAIL_CLAIM_MS), () => {
        sent++;
        return Promise.resolve();
      });
      expect(sent).toBe(0);
    });
  });

  test('release cannot restore another person or rows marked by another attempt, and is idempotent', async () => {
    await withRollback(async (db) => {
      const first = await waitingClaim(db);
      const other = await waitingClaim(db);
      const newer = new Date(NOW.getTime() + 1);
      await db
        .updateTable('notifications')
        .set({ mailed_at: newer })
        .where('id', '=', first.notificationId)
        .execute();
      await db
        .updateTable('missed_mail_claims')
        .set({ notification_ids: [first.notificationId, other.notificationId] })
        .where('letter_id', '=', first.letterId)
        .execute();
      expect(await releaseMailClaim(db, other.userId, first.letterId)).toBe(false);
      expect(await releaseMailClaim(db, first.userId, first.letterId)).toBe(true);
      expect(await releaseMailClaim(db, first.userId, first.letterId)).toBe(false);
      const rows = await db
        .selectFrom('notifications')
        .select(['id', 'mailed_at'])
        .where('id', 'in', [first.notificationId, other.notificationId])
        .execute();
      expect(rows.find((row) => row.id === first.notificationId)?.mailed_at).toEqual(newer);
      expect(rows.find((row) => row.id === other.notificationId)?.mailed_at).toEqual(NOW);
      await settleMailClaim(db, first.userId, first.letterId);
      expect(
        await db
          .selectFrom('missed_mail_claims')
          .select('lease_until')
          .where('letter_id', '=', first.letterId)
          .executeTakeFirst(),
      ).toEqual({ lease_until: null });
    });
  });

  for (const change of ['read', 'opt-out', 'removed', 'unverified'] as const) {
    test(`recovery rebuilds current authority after ${change}`, async () => {
      await withRollback(async (db) => {
        const claim = await waitingClaim(db);
        if (change === 'read')
          await db
            .updateTable('notifications')
            .set({ read_at: NOW })
            .where('id', '=', claim.notificationId)
            .execute();
        if (change === 'opt-out')
          await db
            .updateTable('users')
            .set({ missed_mail_since: null })
            .where('id', '=', claim.userId)
            .execute();
        if (change === 'removed')
          await db.deleteFrom('workspace_members').where('user_id', '=', claim.userId).execute();
        if (change === 'unverified')
          await db
            .updateTable('users')
            .set({ email_verified: false })
            .where('id', '=', claim.userId)
            .execute();
        let sent = 0;
        await run(db, new Date(NOW.getTime() + MISSED_MAIL_CLAIM_MS), () => {
          sent++;
          return Promise.resolve();
        });
        expect(sent).toBe(0);
        expect(
          await db
            .selectFrom('missed_mail_claims')
            .select('lease_until')
            .where('letter_id', '=', claim.letterId)
            .executeTakeFirst(),
        ).toEqual({ lease_until: null });
      });
    });
  }

  for (const size of [0, 1, 100, 101, 1000]) {
    test(`recovery is bounded to 100 attempts with ${String(size)} expired claims`, async () => {
      await withRollback(async (db) => {
        const claim = await waitingClaim(db, new Date(NOW.getTime() - 31 * DAY_MS));
        if (size === 0)
          await db
            .deleteFrom('missed_mail_claims')
            .where('letter_id', '=', claim.letterId)
            .execute();
        if (size > 1) {
          const letters = await db
            .insertInto('missed_mail_letters')
            .values(
              Array.from({ length: size - 1 }, () => ({
                user_id: claim.userId,
                sent_at: new Date(NOW.getTime() - 31 * DAY_MS),
                stop_digest: randomToken(),
              })),
            )
            .returning('id')
            .execute();
          await db
            .insertInto('missed_mail_claims')
            .values(
              letters.map((letter) => ({
                letter_id: letter.id,
                notification_ids: [claim.notificationId],
                lease_until: new Date(NOW.getTime() - DAY_MS),
              })),
            )
            .execute();
        }
        // No relay: recover before retention, and leave every not-yet-recovered pending claim intact.
        await run(db, NOW, undefined);
        const pending = await db
          .selectFrom('missed_mail_claims')
          .select('letter_id')
          .where('lease_until', 'is not', null)
          .execute();
        expect(pending).toHaveLength(Math.max(0, size - 100));
        if (size > 0)
          expect(
            (
              await db
                .selectFrom('notifications')
                .select('mailed_at')
                .where('id', '=', claim.notificationId)
                .executeTakeFirstOrThrow()
            ).mailed_at,
          ).toBeNull();
      });
    });
  }

  test('a live claim is not stolen; an old SMTP completion cannot settle replacement work', async () => {
    const owned = await cloneIntegrationDatabase();
    const firstWait = Promise.withResolvers<undefined>();
    const secondWait = Promise.withResolvers<undefined>();
    const arrived = Promise.withResolvers<undefined>();
    const replaced = Promise.withResolvers<undefined>();
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      const claim = await waitingClaim(owned.db);
      await atomicallyOn(owned.db)(
        async (transaction) => await releaseMailClaim(transaction, claim.userId, claim.letterId),
      );
      first = run(owned.db, NOW, async () => {
        arrived.resolve(undefined);
        await firstWait.promise;
      });
      await arrived.promise;
      let early = 0;
      await run(owned.db, new Date(NOW.getTime() + MISSED_MAIL_CLAIM_MS - 1), () => {
        early++;
        return Promise.resolve();
      });
      expect(early).toBe(0);
      second = run(owned.db, new Date(NOW.getTime() + MISSED_MAIL_CLAIM_MS), async () => {
        replaced.resolve(undefined);
        await secondWait.promise;
      });
      await replaced.promise;
      const active = await owned.db
        .selectFrom('missed_mail_claims')
        .select('letter_id')
        .where('lease_until', 'is not', null)
        .executeTakeFirstOrThrow();
      firstWait.resolve(undefined);
      await first;
      expect(
        await owned.db
          .selectFrom('missed_mail_claims')
          .select('letter_id')
          .where('letter_id', '=', active.letter_id)
          .where('lease_until', 'is not', null)
          .executeTakeFirst(),
      ).toBeDefined();
      secondWait.resolve(undefined);
      await second;
      expect(
        await owned.db
          .selectFrom('missed_mail_claims')
          .select('letter_id')
          .where('lease_until', 'is not', null)
          .execute(),
      ).toEqual([]);
    } finally {
      firstWait.resolve(undefined);
      secondWait.resolve(undefined);
      await Promise.allSettled([first, second]);
      await owned.drop();
    }
  }, 30_000);

  test('acknowledgement SQL failure keeps the claim recoverable while other recipients continue', async () => {
    const owned = await cloneIntegrationDatabase();
    try {
      const one = await waitingClaim(owned.db);
      const two = await waitingClaim(owned.db);
      // The refused recipient runs first, so the test proves delivery continues after the failure.
      const refusedUserId = [one.userId, two.userId].sort()[0] ?? '';
      await atomicallyOn(owned.db)(
        async (transaction) => await releaseMailClaim(transaction, one.userId, one.letterId),
      );
      await atomicallyOn(owned.db)(
        async (transaction) => await releaseMailClaim(transaction, two.userId, two.letterId),
      );
      await sql`create function fail_mail_ack() returns trigger language plpgsql as
      ${sql.raw(`$$ begin if exists(select 1 from missed_mail_letters where id=old.letter_id and user_id='${refusedUserId}'::uuid) then raise exception 'injected acknowledgement failure'; end if; return old; end $$`)}`.execute(
        owned.db,
      );
      await sql`create trigger fail_mail_ack before delete on missed_mail_claims for each row execute function fail_mail_ack()`.execute(
        owned.db,
      );
      const letters: MailMessage[] = [];
      const failure = await run(owned.db, NOW, (letter) => {
        letters.push(letter);
        return Promise.resolve();
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('could not be completed');
      expect(letters).toHaveLength(2);
      expect(
        await owned.db
          .selectFrom('missed_mail_claims')
          .select('letter_id')
          .where('lease_until', 'is not', null)
          .execute(),
      ).toHaveLength(1);
      await sql`drop trigger fail_mail_ack on missed_mail_claims`.execute(owned.db);
      await run(owned.db, new Date(NOW.getTime() + MISSED_MAIL_CLAIM_MS), (letter) => {
        letters.push(letter);
        return Promise.resolve();
      });
      expect(letters).toHaveLength(3);
      expect(letters.slice(0, 2).map((letter) => letter.messageId)).toContain(
        letters[2]?.messageId,
      );
    } finally {
      await owned.drop();
    }
  }, 30_000);

  test('later recipients get a fresh lease even when the job has taken over five minutes', async () => {
    await withRollback(async (db) => {
      const one = await waitingClaim(db);
      const two = await waitingClaim(db);
      await releaseMailClaim(db, one.userId, one.letterId);
      await releaseMailClaim(db, two.userId, two.letterId);
      let current = NOW;
      let sent = 0;
      await mailMissedMessages({
        database: db,
        clock: { now: () => current },
        log: aRecordingLogger().log,
        appUrl: 'https://purlay.test',
        send: () => {
          sent++;
          current = new Date(current.getTime() + MISSED_MAIL_CLAIM_MS + 1);
          return Promise.resolve();
        },
      });
      expect(sent).toBe(2);
    });
  });

  test('a pending claim holds newer notifications until it is settled or recovered', async () => {
    await withRollback(async (db) => {
      const claim = await waitingClaim(db);
      const source = await db
        .selectFrom('notifications')
        .select(['workspace_id', 'channel_id', 'message_id', 'created_at'])
        .where('id', '=', claim.notificationId)
        .executeTakeFirstOrThrow();
      // Different reason avoids the per-message/reason uniqueness key while creating another due item.
      await db
        .insertInto('notifications')
        .values({ ...source, user_id: claim.userId, type: 'direct_message' })
        .execute();
      let sent = 0;
      await run(db, NOW, () => {
        sent++;
        return Promise.resolve();
      });
      expect(sent).toBe(0);
    });
  });

  test('a claim expiring before the final handoff is returned without SMTP', async () => {
    await withRollback(async (db) => {
      const claim = await waitingClaim(db);
      await releaseMailClaim(db, claim.userId, claim.letterId);
      let reads = 0;
      let sent = 0;
      await mailMissedMessages({
        database: db,
        clock: { now: () => (++reads >= 3 ? new Date(NOW.getTime() + MISSED_MAIL_CLAIM_MS) : NOW) },
        log: aRecordingLogger().log,
        appUrl: 'https://purlay.test',
        send: () => {
          sent++;
          return Promise.resolve();
        },
      });
      expect(sent).toBe(0);
      expect(
        (
          await db
            .selectFrom('notifications')
            .select('mailed_at')
            .where('id', '=', claim.notificationId)
            .executeTakeFirstOrThrow()
        ).mailed_at,
      ).toBeNull();
    });
  });
});
