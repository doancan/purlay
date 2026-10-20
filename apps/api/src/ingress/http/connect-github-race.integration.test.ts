/**
 * Two accounts made by email connecting the same GitHub account at once (D-176) — two people who both
 * know the GitHub password, or one person in two accounts — is one connected and one told it is taken.
 *
 * Both callbacks look for an account that already has the GitHub id, find none, and write it. Two
 * things stand in the way. The advisory lock in `completeConnect` makes the second wait, look again,
 * and refuse — logging why. Behind it the unique index refuses the second write, which `errors.ts`
 * answers as `taken` too, but silently. The person sees the same either way, so this asks for the
 * warning as well: only the lock writes it, and a connect that lost the lock would pass on the index
 * alone, unnoticed.
 *
 * On a cloned database with two real connections, because inside the harness's single transaction
 * there is no second callback to race (D-46, D-77). A trigger that sleeps before the write holds the
 * window open, so the outcome is decided by the lock and not by scheduling.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { createApp } from './app';
import { STATE_COOKIE } from '../../platform/cookies';
import { fixedClock } from '../../platform/clock';
import { NOW, aGitHubAccount, aRecordingLogger, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';

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

describe('integration: two accounts connecting one GitHub account at once', () => {
  test('one is connected, the other is told it is taken, and the GitHub account is on one row', async () => {
    const githubId = 800_000_000 + Math.floor(Math.random() * 99_999_999);
    const github = aGitHubAccount(
      { id: githubId, login: `race-${String(githubId)}`, name: 'Shared', avatarUrl: null },
      [{ email: `race-${String(githubId)}@example.test`, primary: true, verified: true }],
    );
    const { log, lines } = aRecordingLogger();
    const app = createApp(testDependencies({ database: cloned.db, clock, github, log }));
    const suffix = crypto.randomUUID().slice(0, 8);
    const ada = await aSignedInUser(cloned.db, clock, `race-ada-${suffix}`);
    const bob = await aSignedInUser(cloned.db, clock, `race-bob-${suffix}`);

    /** Pressed on the account page; answers the callback to send once the window is held. */
    const start = async (as: SignedInUser): Promise<() => Promise<Response>> => {
      const started = await app.handle(
        new Request(`${ORIGIN}/api/me/github/connect`, {
          method: 'POST',
          headers: {
            cookie: as.cookie,
            origin: ORIGIN,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ workspace: 'acme-eng' }),
        }),
      );
      expect(started.status).toBe(200);
      const stateCookie =
        started.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith(`${STATE_COOKIE}=`))
          ?.split(';')[0] ?? '';
      const { location } = (await started.json()) as { location: string };
      const state = new URL(location).searchParams.get('state') ?? '';
      return async () =>
        await app.handle(
          new Request(`${ORIGIN}/auth/github/callback?code=a-valid-code&state=${state}`, {
            headers: { cookie: `${stateCookie}; ${as.cookie}` },
          }),
        );
    };
    const outcome = (response: Response): string | null =>
      new URL(response.headers.get('location') ?? '', ORIGIN).searchParams.get('github');

    // Each callback needs its own state, so start both before racing the callbacks.
    const [adaFinishes, bobFinishes] = [await start(ada), await start(bob)];
    await sql`create trigger hold before update on users for each row execute function hold_window()`.execute(
      cloned.db,
    );
    try {
      const responses = await Promise.all([adaFinishes(), bobFinishes()]);
      expect(responses.map((response) => response.status)).toEqual([302, 302]);
      expect(responses.map(outcome).sort()).toEqual(['connected', 'taken']);
    } finally {
      await sql`drop trigger hold on users`.execute(cloned.db);
    }

    const holders = await cloned.db
      .selectFrom('users')
      .select('id')
      .where('github_id', '=', String(githubId))
      .execute();
    expect(holders).toHaveLength(1);
    expect([ada.userId, bob.userId]).toContain(holders[0]?.id ?? '');
    expect(
      lines.filter(
        (line) => line['msg'] === 'GitHub connect refused: the GitHub account is another account’s',
      ),
    ).toHaveLength(1);
  });
});
