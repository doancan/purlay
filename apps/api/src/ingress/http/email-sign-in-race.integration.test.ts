/**
 * Many requests for one address at once still send five messages an hour (#81, D-138 §7).
 *
 * Each request counts the address's messages and then writes its own. Without a lock, requests at once
 * each count the same few and each write: a limit only for the patient. On a cloned database with real
 * connections, because inside the harness's single transaction nothing races (D-46, D-77); a trigger
 * that sleeps before each insert holds the window open, so the outcome is not left to scheduling.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import type { MailMessage, Outbox } from '../../platform/mail';
import { NOW, testDependencies } from '../../testing/doubles';
import { SIGN_IN_LINKS_PER_HOUR } from '../../modules/auth/email-sign-in';
import { createApp } from './app';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function hold_window() returns trigger language plpgsql as
    $$ begin perform pg_sleep(0.1); return new; end $$
  `.execute(cloned.db);
  await sql`create trigger hold before insert on email_sign_ins for each row execute function hold_window()`.execute(
    cloned.db,
  );
});

afterAll(async () => {
  await cloned.drop();
});

const APP = 'https://purlay.test';

describe('integration: asking for links to one address at once', () => {
  test('every request is answered 202, and five messages are sent', async () => {
    const posted: MailMessage[] = [];
    const mail: Outbox = {
      post: (message): void => {
        posted.push(message);
      },
      flush: () => Promise.resolve(),
    };
    const app = createApp(testDependencies({ database: cloned.db, clock: fixedClock(NOW), mail }));
    const email = `race-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const answers = await Promise.all(
      Array.from(
        { length: SIGN_IN_LINKS_PER_HOUR + 2 },
        async () =>
          await app.handle(
            new Request(`${APP}/auth/email`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', origin: APP },
              body: JSON.stringify({ email, locale: 'en' }),
            }),
          ),
      ),
    );
    expect(answers.map((answer) => answer.status)).toEqual(
      Array.from({ length: SIGN_IN_LINKS_PER_HOUR + 2 }, () => 202),
    );
    expect(posted).toHaveLength(SIGN_IN_LINKS_PER_HOUR);
    const rows = await cloned.db
      .selectFrom('email_sign_ins')
      .select('id')
      .where('email', '=', email)
      .execute();
    expect(rows).toHaveLength(SIGN_IN_LINKS_PER_HOUR);
  });
});
