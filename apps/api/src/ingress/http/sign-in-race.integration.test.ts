/**
 * The same GitHub account completing sign-in twice at once — a double-clicked
 * callback, or two tabs — is two successes and one account (D-78).
 *
 * Both callbacks look for the account, find none, and insert. The second insert
 * violated `users_github_id_key` and answered `500`. The statement now resolves
 * the conflict itself, so whichever arrives second refreshes the row the first
 * made and carries on.
 *
 * On a cloned database with two real connections, because inside the harness's
 * single transaction there is no second callback to race (D-46, D-77). A trigger
 * that sleeps before the insert holds the window open: without it the outcome is
 * decided by scheduling, and a test that passes fifteen times in sixteen is worse
 * than none. The sleep is after each callback's lookup, so both find nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { createApp } from './app';
import { NOW, aGitHubAccount, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function hold_window() returns trigger language plpgsql as
    $$ begin perform pg_sleep(0.3); return new; end $$
  `.execute(cloned.db);
});

afterAll(async () => {
  await cloned.drop();
});

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);

describe('integration: two callbacks for one GitHub account', () => {
  test('both sign in, and there is one account with a session each', async () => {
    const login = `race-${crypto.randomUUID().slice(0, 8)}`;
    const email = `${login}@example.test`;
    const github = aGitHubAccount(
      {
        id: Math.floor(Math.random() * 1_000_000_000) + 1_000_000,
        login,
        name: 'Racer',
        avatarUrl: null,
      },
      [{ email, primary: true, verified: true }],
    );
    const app = createApp(testDependencies({ database: cloned.db, clock, github }));

    const signIn = async (): Promise<Response> => {
      const started = await app.handle(new Request(`${ORIGIN}/auth/github`));
      const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
      const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      return await app.handle(
        new Request(`${ORIGIN}/auth/github/callback?code=a-valid-code&state=${state}`, {
          headers: { cookie },
        }),
      );
    };

    // Each callback needs its own state, so start both before racing the callbacks.
    await sql`create trigger hold before insert on users for each row execute function hold_window()`.execute(
      cloned.db,
    );
    try {
      const [first, second] = await Promise.all([signIn(), signIn()]);
      expect([first.status, second.status]).toEqual([302, 302]);
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
});
