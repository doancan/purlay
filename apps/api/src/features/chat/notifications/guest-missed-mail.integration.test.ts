/** Queued email must obey guest history and authority at the final relay handoff. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  sql,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
  type Transaction,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { type MailMessage } from '../../../platform/mail';
import { aRoom } from '../../../testing/rooms';
import { aRecordingLogger } from '../../../testing/doubles';
import { mailMissedMessages } from './missed-mail';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const setup = async (
  db: Transaction,
): Promise<{
  readonly userId: string;
  readonly now: Date;
  readonly notificationIds: readonly string[];
}> => {
  const now = new Date();
  const room = await aRoom(db, ['owner', 'guest']);
  const userId = room.members['guest']?.userId ?? '';
  const since = new Date(now.getTime() - 40 * 60_000);
  await db
    .updateTable('workspace_members')
    .set({ access_kind: 'guest', guest_since: since, guest_modules: ['chat'] })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', userId)
    .execute();
  await db
    .updateTable('channel_members')
    .set({ joined_at: since })
    .where('channel_id', '=', room.channelId)
    .where('user_id', '=', userId)
    .execute();
  await db
    .updateTable('users')
    .set({ email_verified: true, missed_mail_since: new Date(now.getTime() - 60 * 60_000) })
    .where('id', '=', userId)
    .execute();
  const notificationIds: string[] = [];
  for (const [ageMinutes, content] of [
    [50, 'Earlier confidential words'],
    [20, 'New shared words'],
  ] as const) {
    const created = new Date(now.getTime() - ageMinutes * 60_000);
    const id = messageId(created);
    await db
      .insertInto('messages')
      .values({
        id,
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        sender_id: room.members['owner']?.userId ?? '',
        created_at: created,
        content,
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
        created_at: new Date(now.getTime() - 19 * 60_000),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    notificationIds.push(notification.id);
  }
  return { userId, now, notificationIds };
};

const run = async (
  db: Transaction,
  now: Date,
  letters: MailMessage[],
): Promise<Awaited<ReturnType<typeof mailMissedMessages>>> =>
  await mailMissedMessages({
    database: db,
    clock: fixedClock(now),
    appUrl: 'https://purlay.test',
    log: aRecordingLogger().log,
    send: (letter) => {
      letters.push(letter);
      return Promise.resolve();
    },
  });

describe('integration: guest missed-mail authority', () => {
  test.each(['suspended', 'deleted', 'unverified'] as const)(
    'a %s account does not claim or settle waiting notifications',
    async (state) => {
      await withRollback(async (db) => {
        const { userId, now, notificationIds } = await setup(db);
        await db
          .updateTable('users')
          .set({
            ...(state === 'suspended' ? { suspended_at: now } : {}),
            ...(state === 'deleted' ? { deleted_at: now } : {}),
            ...(state === 'unverified' ? { email_verified: false } : {}),
          })
          .where('id', '=', userId)
          .execute();
        const letters: MailMessage[] = [];
        expect(await run(db, now, letters)).toMatchObject({ letters: 0 });
        expect(letters).toEqual([]);
        expect(
          (
            await db
              .selectFrom('notifications')
              .select('mailed_at')
              .where('id', 'in', notificationIds)
              .execute()
          ).every((row) => row.mailed_at === null),
        ).toBe(true);
      }, cloned.db);
    },
  );

  test('a queued notification cannot quote content from before guest admission', async () => {
    await withRollback(async (db) => {
      const { now } = await setup(db);
      const letters: MailMessage[] = [];
      expect(await run(db, now, letters)).toMatchObject({ letters: 1, failed: 0 });
      expect(letters).toHaveLength(1);
      expect(letters[0]?.text).toContain('New shared words');
      expect(letters[0]?.text).not.toContain('Earlier confidential words');
    }, cloned.db);
  });

  test.each([
    'expiry',
    'removed',
    'opt-out',
    'address',
    'read',
    'quiet',
    'suspended',
    'deleted',
    'unverified',
    'message-deleted',
    'scope',
    'floor',
    'module',
    'opt-in-reset',
    'reason',
  ] as const)(
    '%s after a claim suppresses the letter before relay handoff without spending its hour',
    async (change) => {
      await withRollback(async (db) => {
        const { userId, now, notificationIds } = await setup(db);
        const actions = {
          expiry:
            "update workspace_members set guest_expires_at = statement_timestamp() where user_id = new.user_id and access_kind = 'guest';",
          removed: 'delete from workspace_members where user_id = new.user_id;',
          'opt-out': 'update users set missed_mail_since = null where id = new.user_id;',
          address: "update users set email = 'changed-' || email where id = new.user_id;",
          read: 'update notifications set read_at = statement_timestamp() where user_id = new.user_id;',
          quiet:
            "update workspace_members set is_deep_work_active = true, deep_work_until = statement_timestamp() + interval '1 hour' where user_id = new.user_id;",
          suspended:
            'update users set suspended_at = statement_timestamp() where id = new.user_id;',
          deleted: 'update users set deleted_at = statement_timestamp() where id = new.user_id;',
          unverified: 'update users set email_verified = false where id = new.user_id;',
          'message-deleted':
            'update messages set deleted_at = statement_timestamp() where id in (select message_id from notifications where user_id = new.user_id);',
          scope: 'delete from channel_members where user_id = new.user_id;',
          floor:
            'update channel_members set joined_at = statement_timestamp() where user_id = new.user_id;',
          module:
            "update workspace_members set guest_modules = array['issues']::text[] where user_id = new.user_id;",
          'opt-in-reset':
            'update users set missed_mail_since = statement_timestamp() where id = new.user_id;',
          reason: "update notifications set type = 'thread_reply' where user_id = new.user_id;",
        };
        // A real database boundary changes authority after content selection, before the claim returns.
        // The send adapter records only whether anything crossed the relay seam.
        await sql`create function change_guest_mail_authority() returns trigger language plpgsql as
          ${sql.raw(`$$ begin ${actions[change]} return new; end $$`)}`.execute(db);
        await sql`create trigger change_guest_mail_authority after insert on missed_mail_letters
          for each row execute function change_guest_mail_authority()`.execute(db);
        const letters: MailMessage[] = [];
        expect(await run(db, now, letters)).toMatchObject({ letters: 0, failed: 0, refused: 0 });
        expect(letters).toEqual([]);
        expect(
          await db
            .selectFrom('missed_mail_letters')
            .select('id')
            .where('user_id', '=', userId)
            .execute(),
        ).toEqual([]);
        const marked = await db
          .selectFrom('notifications')
          .select('mailed_at')
          .where('id', 'in', notificationIds)
          .execute();
        // Before-history notifications may be settled permanently; the readable row must be returned.
        expect(marked.some((row) => row.mailed_at === null)).toBe(true);
        if (change === 'quiet') {
          await sql`drop trigger change_guest_mail_authority on missed_mail_letters`.execute(db);
          await db
            .updateTable('workspace_members')
            .set({ is_deep_work_active: false, deep_work_until: null })
            .where('user_id', '=', userId)
            .execute();
          expect(await run(db, now, letters)).toMatchObject({ letters: 1, failed: 0 });
          expect(letters[0]?.text).toContain('New shared words');
          expect(letters[0]?.text).not.toContain('Earlier confidential words');
        }
      }, cloned.db);
    },
  );
});
