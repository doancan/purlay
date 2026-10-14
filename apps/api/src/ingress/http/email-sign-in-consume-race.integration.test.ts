/**
 * Two links to one new address used at once — two tabs, two messages — are two sign-ins and one account
 * (#81, D-138, as D-78 for GitHub).
 *
 * Both spend their own link, look for the account, find none, and insert. The insert resolves the
 * conflict itself and the account is read back, so whichever arrives second signs into the one the
 * first made. On a cloned database with two real connections (D-46, D-77); a trigger that sleeps before
 * the insert holds the window open, so both have looked before either has written.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import type { MailMessage, Outbox } from '../../platform/mail';
import { NOW, testDependencies } from '../../testing/doubles';
import { createApp } from './app';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function hold_window() returns trigger language plpgsql as
    $$ begin perform pg_sleep(0.3); return new; end $$
  `.execute(cloned.db);
  // A second's hold for the race on a name: the other request has its own row to spend and its own
  // lookup to make before it reaches the insert, all of which must land inside the first one's hold,
  // even on a machine busy with something else.
  await sql`
    create function hold_longer() returns trigger language plpgsql as
    $$ begin perform pg_sleep(1); return new; end $$
  `.execute(cloned.db);
});

afterAll(async () => {
  await cloned.drop();
});

const APP = 'https://purlay.test';

const post = (path: string, body: unknown): Request =>
  new Request(`${APP}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: APP },
    body: JSON.stringify(body),
  });

describe('integration: two links to one new address used at once', () => {
  test('both sign in, and there is one account with a session each', async () => {
    const posted: MailMessage[] = [];
    const mail: Outbox = {
      post: (message): void => {
        posted.push(message);
      },
      flush: () => Promise.resolve(),
    };
    const app = createApp(testDependencies({ database: cloned.db, clock: fixedClock(NOW), mail }));
    const email = `race-${crypto.randomUUID().slice(0, 8)}@example.test`;
    for (let n = 0; n < 2; n += 1) {
      expect((await app.handle(post('/auth/email', { email, locale: 'en' }))).status).toBe(202);
    }
    const tokens = posted.map((message) => /#([0-9a-f]{64})/.exec(message.text)?.[1] ?? '');
    expect(tokens.map((token) => token.length)).toEqual([64, 64]);

    await sql`create trigger hold before insert on users for each row execute function hold_window()`.execute(
      cloned.db,
    );
    try {
      const answers = await Promise.all(
        tokens.map(async (token) => await app.handle(post('/auth/email/consume', { token }))),
      );
      expect(answers.map((answer) => answer.status)).toEqual([204, 204]);
    } finally {
      await sql`drop trigger hold on users`.execute(cloned.db);
    }

    const accounts = await cloned.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .execute();
    expect(accounts).toHaveLength(1);
    const sessions = await cloned.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', accounts[0]?.id ?? '')
      .execute();
    expect(sessions).toHaveLength(2);
  });

  test('two new addresses wanting one name at once: one signs in, the other fails loudly and works when pressed again', async () => {
    const posted: MailMessage[] = [];
    const mail: Outbox = {
      post: (message): void => {
        posted.push(message);
      },
      flush: () => Promise.resolve(),
    };
    const app = createApp(testDependencies({ database: cloned.db, clock: fixedClock(NOW), mail }));
    const local = `twin-${crypto.randomUUID().slice(0, 8)}`;
    for (const domain of ['a.test', 'b.test']) {
      expect(
        (await app.handle(post('/auth/email', { email: `${local}@${domain}`, locale: 'en' })))
          .status,
      ).toBe(202);
    }
    const tokens = posted.map((message) => /#([0-9a-f]{64})/.exec(message.text)?.[1] ?? '');

    await sql`create trigger hold before insert on users for each row execute function hold_longer()`.execute(
      cloned.db,
    );
    let answers: Response[];
    try {
      answers = await Promise.all(
        tokens.map(async (token) => await app.handle(post('/auth/email/consume', { token }))),
      );
    } finally {
      await sql`drop trigger hold on users`.execute(cloned.db);
    }
    expect(answers.map((answer) => answer.status).sort()).toEqual([204, 500]);
    // The failure undid its spend: the same link, pressed again, signs in under the next name.
    const failed = tokens[answers.findIndex((answer) => answer.status === 500)] ?? '';
    expect((await app.handle(post('/auth/email/consume', { token: failed }))).status).toBe(204);
    const names = await cloned.db
      .selectFrom('users')
      .select('username')
      .where('email', 'in', [`${local}@a.test`, `${local}@b.test`])
      .orderBy('username')
      .execute();
    expect(names.map((row) => row.username)).toEqual([local, `${local}-1`]);
  });
});
