/**
 * Email about what a person missed (D-240), against the database: what is mailed — a mention or a direct
 * message, unread past the delay, told since the setting was turned on — and everything that keeps a letter
 * from going: the hour since the last, Deep Work and quiet hours, an account erased, suspended or never
 * verified, a channel or workspace no longer theirs, a deleted message, no relay. Never twice, two runs at
 * once included; a relay that refuses gives the rows back. And the stop link: the person it was sent to, and
 * nobody else, for thirty days.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  withRollback,
  type Executor,
} from '@purlay/db';
import { messageId } from '@purlay/types';
import { DAY_MS, fixedClock, HOUR_MS, type Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { smtpMailer, type MailMessage, type SendMail } from '../../platform/mail';
import { aRecordingLogger, NOW } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aScriptedRelay } from '../../testing/smtp-relay';
import {
  MISSED_MAIL_DELAY_MS,
  mailMissedMessages,
  readMissedMail,
  setMissedMail,
  STOP_LINK_DAYS,
  stopMissedMail,
} from './missed-mail';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const APP = 'https://purlay.test';
const MINUTE = 60_000;
let tick = 0;

interface Postbox {
  readonly letters: MailMessage[];
  readonly send: SendMail;
}

const aPostbox = (): Postbox => {
  const letters: MailMessage[] = [];
  return {
    letters,
    send: (letter): Promise<void> => {
      letters.push(letter);
      return Promise.resolve();
    },
  };
};

const run = async (
  db: Executor,
  at: Date,
  send: SendMail | undefined,
): Promise<Awaited<ReturnType<typeof mailMissedMessages>>> =>
  await mailMissedMessages({
    database: db,
    clock: fixedClock(at),
    log: aRecordingLogger().log,
    send,
    appUrl: APP,
  });

/** Ada, who asked a day ago to be mailed, and Bob, who writes to her, in a room of the given kind. */
const aRoomForAda = async (
  db: Executor,
  type: 'public' | 'private' | 'direct_message' = 'public',
): Promise<Room & { readonly ada: string; readonly bob: string }> => {
  const room = await aRoom(db, ['ada', 'bob'], { type });
  const ada = room.members['ada']?.userId ?? '';
  const bob = room.members['bob']?.userId ?? '';
  await db
    .updateTable('users')
    .set({ email_verified: true, missed_mail_since: new Date(NOW.getTime() - DAY_MS) })
    .where('id', '=', ada)
    .execute();
  return { ...room, ada, bob };
};

/** A message from Bob and Ada's notification of it, told at `toldAt`. */
const told = async (
  db: Executor,
  room: Room & { readonly ada: string; readonly bob: string },
  toldAt: Date,
  options: {
    readonly content?: string;
    readonly type?: 'mention' | 'direct_message' | 'thread_reply';
    readonly deleted?: boolean;
  } = {},
): Promise<{ readonly messageId: string; readonly notificationId: string }> => {
  tick += 1;
  const id = messageId(new Date(toldAt.getTime() + tick));
  await db
    .insertInto('messages')
    .values({
      id,
      workspace_id: room.workspaceId,
      channel_id: room.channelId,
      sender_id: room.bob,
      content: options.content ?? `@ada look at this ${String(tick)}`,
      deleted_at: options.deleted === true ? toldAt : null,
    })
    .execute();
  const notification = await db
    .insertInto('notifications')
    .values({
      user_id: room.ada,
      workspace_id: room.workspaceId,
      channel_id: room.channelId,
      message_id: id,
      type: options.type ?? 'mention',
      created_at: toldAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { messageId: id, notificationId: notification.id };
};

const mailedAt = async (db: Executor, notificationId: string): Promise<Date | null> =>
  (
    await db
      .selectFrom('notifications')
      .select('mailed_at')
      .where('id', '=', notificationId)
      .executeTakeFirstOrThrow()
  ).mailed_at;

const stopTokenIn = (letter: MailMessage | undefined): string => {
  const token = /\/mail\/stop#([0-9a-f]{64})/.exec(letter?.text ?? '')?.[1];
  if (token === undefined) throw new Error('the letter carries no stop link');
  return token;
};

const ago = (ms: number, from: Date = NOW): Date => new Date(from.getTime() - ms);

describe('integration: what a letter is about', () => {
  test('a mention unread for the whole delay is mailed, once; one a second short of it waits', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db);
      const due = await told(db, room, ago(MISSED_MAIL_DELAY_MS), { content: 'deploy **is** red' });
      const early = await told(db, room, ago(MISSED_MAIL_DELAY_MS - 1_000));
      const postbox = aPostbox();

      expect(await run(db, NOW, postbox.send)).toMatchObject({ letters: 1, failed: 0 });
      const [letter] = postbox.letters;
      expect(letter?.subject).toBe('Messages are waiting for you on Purlay');
      expect(letter?.text).toContain('#general — 1 message');
      expect(letter?.text).toContain('bob: “deploy is red”');
      expect(letter?.text).toContain(
        `${APP}/w/${await slugOf(db, room.workspaceId)}/c/${room.channelId}?message=${due.messageId}`,
      );
      expect(letter?.text).not.toContain(early.messageId);
      expect(await mailedAt(db, due.notificationId)).toEqual(NOW);
      expect(await mailedAt(db, early.notificationId)).toBeNull();

      // Run again at once: nothing is mailed twice, and the one that was early waits for the hour.
      expect(await run(db, NOW, postbox.send)).toMatchObject({ letters: 0 });
      expect(postbox.letters).toHaveLength(1);
    });
  });

  test('at most one letter an hour: what came in between goes in the next, and the first is not repeated', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db);
      const first = await told(db, room, ago(MISSED_MAIL_DELAY_MS));
      const postbox = aPostbox();
      await run(db, NOW, postbox.send);
      const second = await told(db, room, NOW);

      const halfHour = new Date(NOW.getTime() + 30 * MINUTE);
      expect(await run(db, halfHour, postbox.send)).toMatchObject({ letters: 0 });
      // Exactly an hour after the first: the next may go.
      expect(await run(db, new Date(NOW.getTime() + HOUR_MS), postbox.send)).toMatchObject({
        letters: 1,
      });
      expect(postbox.letters[1]?.text).toContain(second.messageId);
      expect(postbox.letters[1]?.text).not.toContain(first.messageId);
    });
  });

  test('a direct message is mailed, named by who wrote; a thread reply, one already read and one from before the setting are not', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db, 'direct_message');
      const direct = await told(db, room, ago(HOUR_MS), {
        type: 'direct_message',
        content: 'Çağrı’yı gördün mü? Şimdi İstanbul’dayım',
      });
      const reply = await told(db, room, ago(HOUR_MS), { type: 'thread_reply' });
      const read = await told(db, room, ago(HOUR_MS), { type: 'direct_message' });
      await db
        .updateTable('notifications')
        .set({ read_at: ago(MINUTE) })
        .where('id', '=', read.notificationId)
        .execute();
      const old = await told(db, room, ago(2 * DAY_MS), { type: 'direct_message' });
      const postbox = aPostbox();

      await run(db, NOW, postbox.send);
      const [letter] = postbox.letters;
      expect(letter?.text).toContain('bob — 1 message');
      expect(letter?.text).toContain('Çağrı’yı gördün mü? Şimdi İstanbul’dayım');
      expect(letter?.text).toContain(direct.messageId);
      for (const left of [reply, read, old]) {
        expect(letter?.text).not.toContain(left.messageId);
        expect(await mailedAt(db, left.notificationId)).toBeNull();
      }
    });
  });

  test('one letter for every workspace, by name, and in each the conversation written in last comes first', async () => {
    await withRollback(async (db) => {
      const beta = await aRoomForAda(db);
      const ops = await db
        .insertInto('channels')
        .values({ workspace_id: beta.workspaceId, name: 'ops', type: 'public' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('channel_members')
        .values([
          { channel_id: ops.id, user_id: beta.ada },
          { channel_id: ops.id, user_id: beta.bob },
        ])
        .execute();
      const alpha = await aRoom(db, ['carol']);
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: alpha.workspaceId, user_id: beta.ada, role: 'member' })
        .execute();
      await db
        .insertInto('channel_members')
        .values({ channel_id: alpha.channelId, user_id: beta.ada })
        .execute();
      await db
        .updateTable('workspaces')
        .set({ name: 'Beta' })
        .where('id', '=', beta.workspaceId)
        .execute();
      await db
        .updateTable('workspaces')
        .set({ name: 'Alpha' })
        .where('id', '=', alpha.workspaceId)
        .execute();

      await told(db, beta, ago(2 * HOUR_MS), { content: 'older, in general' });
      await told(db, { ...beta, channelId: ops.id }, ago(HOUR_MS), { content: 'newer, in ops' });
      await told(db, { ...alpha, ada: beta.ada, bob: beta.bob }, ago(HOUR_MS), {
        content: 'in the other workspace',
      });
      const postbox = aPostbox();
      expect(await run(db, NOW, postbox.send)).toMatchObject({ letters: 1 });
      const text = postbox.letters[0]?.text ?? '';
      const at = (words: string): number => text.indexOf(words);
      expect(at('Alpha')).toBeGreaterThan(-1);
      expect(at('Alpha')).toBeLessThan(at('Beta'));
      expect(at('Beta')).toBeLessThan(at('#ops — 1 message'));
      // Beta's #general, after its #ops: Alpha has a #general of its own, earlier.
      expect(at('#ops — 1 message')).toBeLessThan(text.lastIndexOf('#general — 1 message'));
    });
  });

  test('in the person’s language, with the newest three quoted and the rest counted', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db);
      await db.updateTable('users').set({ locale: 'tr' }).where('id', '=', room.ada).execute();
      const sent = [];
      for (let index = 0; index < 5; index += 1) {
        sent.push(await told(db, room, ago(HOUR_MS - index * MINUTE)));
      }
      const postbox = aPostbox();
      await run(db, NOW, postbox.send);
      const [letter] = postbox.letters;
      expect(letter?.subject).toBe('Purlay’da seni bekleyen mesajlar var');
      expect(letter?.text).toContain('#general — 5 mesaj');
      expect(letter?.text).toContain('ve 2 tane daha');
      expect(letter?.text).toContain('Bu e-postaları durdurmak için bu bağlantıyı aç:');
      expect(letter?.text).not.toContain(sent[0]?.messageId);
      expect(letter?.text).toContain(sent[4]?.messageId);
    });
  });

  test('somebody else’s words cannot start a line, reorder the text, become a link or markup', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db);
      await told(db, room, ago(HOUR_MS), {
        content: 'line one\nSubject: fake‮evil https://evil.example <script>x</script>',
      });
      const postbox = aPostbox();
      await run(db, NOW, postbox.send);
      const [letter] = postbox.letters;
      expect(letter?.text).not.toContain('\nSubject: fake');
      expect(letter?.text).not.toContain('‮');
      expect(letter?.text).not.toContain('https://evil.example');
      expect(letter?.html).not.toContain('<script>');
      expect(letter?.html).toContain('&lt;script&gt;');
      expect(letter?.html).not.toContain('href="https://evil');
    });
  });
});

describe('integration: what keeps a letter from going', () => {
  test('Deep Work in that workspace, and quiet hours anywhere, hold it — and it goes once they are over, if still unread', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db);
      const held = await told(db, room, ago(HOUR_MS));
      await db
        .updateTable('workspace_members')
        .set({ is_deep_work_active: true, deep_work_until: new Date(NOW.getTime() + HOUR_MS) })
        .where('user_id', '=', room.ada)
        .execute();
      const postbox = aPostbox();
      expect(await run(db, NOW, postbox.send)).toMatchObject({ letters: 0 });
      expect(await mailedAt(db, held.notificationId)).toBeNull();

      // Deep Work over, quiet hours now — 15:00 to 16:00 in Istanbul, a Wednesday, NOW being 15:00 there.
      await db
        .updateTable('workspace_members')
        .set({ is_deep_work_active: false, deep_work_until: null })
        .where('user_id', '=', room.ada)
        .execute();
      await db
        .updateTable('users')
        .set({
          time_zone: 'Europe/Istanbul',
          quiet_from: 15 * 60,
          quiet_to: 16 * 60,
          quiet_days: 8,
        })
        .where('id', '=', room.ada)
        .execute();
      expect(await run(db, NOW, postbox.send)).toMatchObject({ letters: 0 });
      expect(await mailedAt(db, held.notificationId)).toBeNull();

      const after = new Date(NOW.getTime() + HOUR_MS);
      expect(await run(db, after, postbox.send)).toMatchObject({ letters: 1 });
      expect(postbox.letters[0]?.text).toContain(held.messageId);
    });
  });

  test('an account suspended, erased, never verified or with the setting off is never mailed', async () => {
    await withRollback(async (db) => {
      const changes = [
        { suspended_at: NOW },
        { deleted_at: NOW },
        { email_verified: false },
        { missed_mail_since: null },
      ] as const;
      for (const change of changes) {
        const room = await aRoomForAda(db);
        const waiting = await told(db, room, ago(HOUR_MS));
        await db.updateTable('users').set(change).where('id', '=', room.ada).execute();
        const postbox = aPostbox();
        expect(await run(db, NOW, postbox.send)).toMatchObject({ letters: 0 });
        expect(postbox.letters).toEqual([]);
        expect(await mailedAt(db, waiting.notificationId)).toBeNull();
      }
    });
  });

  test('a private channel left, a workspace left and a deleted message are passed over for good, and never quoted', async () => {
    await withRollback(async (db) => {
      const left = await aRoomForAda(db, 'private');
      const fromLeft = await told(db, left, ago(HOUR_MS), { content: 'the secret plan' });
      await db
        .deleteFrom('channel_members')
        .where('user_id', '=', left.ada)
        .where('channel_id', '=', left.channelId)
        .execute();

      // Another workspace, which Ada is not in (any more): her notification from it.
      const removed = await aRoomForAda(db);
      const fromRemoved = await told(db, { ...removed, ada: left.ada }, ago(HOUR_MS), {
        content: 'the other secret',
      });

      const deleted = await told(db, left, ago(HOUR_MS), { deleted: true, content: 'taken back' });
      const postbox = aPostbox();
      expect(await run(db, NOW, postbox.send)).toMatchObject({ letters: 0 });
      expect(postbox.letters).toEqual([]);
      for (const passed of [fromLeft, fromRemoved, deleted]) {
        expect(await mailedAt(db, passed.notificationId)).toEqual(NOW);
      }
    });
  });

  test('beside one that can be mailed, only that one is quoted', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db, 'private');
      await told(db, room, ago(HOUR_MS), { deleted: true, content: 'taken back' });
      const kept = await told(db, room, ago(HOUR_MS), { content: 'still here' });
      const postbox = aPostbox();
      await run(db, NOW, postbox.send);
      expect(postbox.letters[0]?.text).toContain('#general — 1 message');
      expect(postbox.letters[0]?.text).toContain('still here');
      expect(postbox.letters[0]?.text).not.toContain('taken back');
      expect(await mailedAt(db, kept.notificationId)).toEqual(NOW);
    });
  });

  test('with no relay nothing is taken, and a relay added later mails what is still unread', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db);
      const waiting = await told(db, room, ago(HOUR_MS));
      expect(await run(db, NOW, undefined)).toMatchObject({ letters: 0 });
      expect(await mailedAt(db, waiting.notificationId)).toBeNull();
      const postbox = aPostbox();
      expect(await run(db, NOW, postbox.send)).toMatchObject({ letters: 1 });
    });
  });

  test('a relay that refuses: the run fails, says so without the address, and the rows wait for the next run', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db);
      const waiting = await told(db, room, ago(HOUR_MS));
      const { log, lines } = aRecordingLogger();
      const refusing: SendMail = () =>
        Promise.reject(
          Object.assign(new Error(`550 no such user ada@example.test`), { code: 'EENVELOPE' }),
        );
      const failure = await mailMissedMessages({
        database: db,
        clock: fixedClock(NOW),
        log,
        send: refusing,
        appUrl: APP,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('refused by the mail relay');
      expect(
        lines.find((line) => line['msg'] === 'a missed-mail letter could not be sent'),
      ).toMatchObject({ reason: 'EENVELOPE' });
      expect(JSON.stringify(lines)).not.toContain('example.test');
      expect(await mailedAt(db, waiting.notificationId)).toBeNull();
      expect(
        await db
          .selectFrom('missed_mail_letters')
          .select('id')
          .where('user_id', '=', room.ada)
          .execute(),
      ).toEqual([]);
      const postbox = aPostbox();
      expect(await run(db, NOW, postbox.send)).toMatchObject({ letters: 1 });
    });
  });
});

describe('integration: through a real relay', () => {
  test('the letter reaches the relay addressed to the person alone, in text and HTML', async () => {
    const relay = await aScriptedRelay();
    try {
      await withRollback(async (db) => {
        const room = await aRoomForAda(db);
        await told(db, room, ago(HOUR_MS), { content: 'Merhaba Ada, şu PR’a bakar mısın?' });
        const mailer = smtpMailer({
          SMTP_URL: `smtp://127.0.0.1:${String(relay.port)}`,
          MAIL_FROM: 'purlay@example.test',
          SMTP_ALLOW_PLAINTEXT: false,
        });
        expect(await run(db, NOW, mailer.send)).toMatchObject({ letters: 1 });
        mailer.close();
        const email = (
          await db
            .selectFrom('users')
            .select('email')
            .where('id', '=', room.ada)
            .executeTakeFirstOrThrow()
        ).email;
        expect(relay.received).toHaveLength(1);
        expect(relay.received[0]?.to).toEqual([email]);
        expect(relay.received[0]?.data).toContain(
          'Subject: Messages are waiting for you on Purlay',
        );
        expect(relay.received[0]?.data).toContain('text/html');
      });
    } finally {
      await relay.stop();
    }
  });
});

describe('integration: two runs at once', () => {
  test(
    'one letter, never two, for the same notifications',
    async () => {
      const cloned = await cloneIntegrationDatabase();
      try {
        const room = await aRoomForAda(cloned.db);
        await told(cloned.db, room, ago(HOUR_MS));
        await told(cloned.db, room, ago(HOUR_MS));
        const postbox = aPostbox();
        const runs = await Promise.all([
          run(cloned.db, NOW, postbox.send),
          run(cloned.db, NOW, postbox.send),
          run(cloned.db, NOW, postbox.send),
        ]);
        expect(runs.reduce((sum, outcome) => sum + outcome.letters, 0)).toBe(1);
        expect(postbox.letters).toHaveLength(1);
        expect(postbox.letters[0]?.text).toContain('#general — 2 messages');
        expect(
          await cloned.db
            .selectFrom('missed_mail_letters')
            .select('id')
            .where('user_id', '=', room.ada)
            .execute(),
        ).toHaveLength(1);
      } finally {
        await cloned.drop();
      }
    },
    CLONE_HOOK_MS + DROP_HOOK_MS,
  );
});

describe('integration: the setting and its stop link', () => {
  const clock: Clock = fixedClock(NOW);

  test('off at first; on from now, kept as it was when turned on again; off; never on where mail cannot go', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db);
      expect(await readMissedMail(db, room.bob, true)).toEqual({ on: false, available: false });
      await db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', room.bob)
        .execute();
      expect(await readMissedMail(db, room.bob, true)).toEqual({ on: false, available: true });
      expect(await readMissedMail(db, room.bob, false)).toEqual({ on: false, available: false });
      const refusal = await setMissedMail(db, clock, room.bob, { on: true }, false).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(AppError);

      expect(await setMissedMail(db, clock, room.bob, { on: true }, true)).toEqual({
        on: true,
        available: true,
      });
      await setMissedMail(
        db,
        fixedClock(new Date(NOW.getTime() + HOUR_MS)),
        room.bob,
        { on: true },
        true,
      );
      const since = await db
        .selectFrom('users')
        .select('missed_mail_since')
        .where('id', '=', room.bob)
        .executeTakeFirstOrThrow();
      expect(since.missed_mail_since).toEqual(NOW);
      // Off is always allowed, relay or not.
      expect(await setMissedMail(db, clock, room.bob, { on: false }, false)).toEqual({
        on: false,
        available: false,
      });
    });
  });

  test('the link turns it off for the person it was sent to and nobody else, again and again, for thirty days', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db);
      await db
        .updateTable('users')
        .set({ email_verified: true, missed_mail_since: NOW })
        .where('id', '=', room.bob)
        .execute();
      await told(db, room, ago(HOUR_MS));
      const postbox = aPostbox();
      await run(db, NOW, postbox.send);
      const token = stopTokenIn(postbox.letters[0]);

      const refused = async (given: string, at: Date = NOW): Promise<void> => {
        const refusal = await stopMissedMail(db, fixedClock(at), { token: given }).catch(
          (error: unknown) => error,
        );
        expect(refusal).toMatchObject({ body: { code: 'MAIL_LINK_NOT_FOUND' } });
      };
      // Tampered: one digit changed.
      await refused(`${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`);
      await refused('f'.repeat(64));
      // Past its thirty days.
      await refused(token, new Date(NOW.getTime() + STOP_LINK_DAYS * DAY_MS + 1));

      await stopMissedMail(db, clock, { token });
      await stopMissedMail(db, clock, { token });
      expect((await readMissedMail(db, room.ada, true)).on).toBe(false);
      expect((await readMissedMail(db, room.bob, true)).on).toBe(true);
    });
  });

  test('the run forgets a letter once its link no longer opens', async () => {
    await withRollback(async (db) => {
      const room = await aRoomForAda(db);
      await told(db, room, ago(HOUR_MS));
      await run(db, NOW, aPostbox().send);
      const count = async (): Promise<number> =>
        (
          await db
            .selectFrom('missed_mail_letters')
            .select('id')
            .where('user_id', '=', room.ada)
            .execute()
        ).length;
      expect(await count()).toBe(1);
      await run(db, new Date(NOW.getTime() + STOP_LINK_DAYS * DAY_MS - 1), undefined);
      expect(await count()).toBe(1);
      expect(
        await run(db, new Date(NOW.getTime() + STOP_LINK_DAYS * DAY_MS), undefined),
      ).toMatchObject({
        forgotten: 1,
      });
      expect(await count()).toBe(0);
    });
  });
});

const slugOf = async (db: Executor, workspaceId: string): Promise<string> =>
  (
    await db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow()
  ).slug;
