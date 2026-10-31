/**
 * The same GitHub account completing sign-in twice at once — two tabs — is two sessions and one
 * account (D-78).
 *
 * Both callbacks look for the account, find none, and insert. Under the sign-in library (D-179)
 * the second insert loses on a unique index inside the library's own transaction, and the library
 * answers it `unable_to_create_user` — its state already spent, so nothing can be retried inside
 * that callback. The account the first tab made exists by then, so the second tab is sent round
 * again (`/auth/github`): GitHub authorises it without a prompt, and this time the library finds
 * the account. Once only — a marker cookie says it was sent round, and a second loss is `failed`.
 *
 * On a cloned database with two real connections, because inside the harness's
 * single transaction there is no second callback to race (D-46, D-77). A trigger
 * that sleeps before the insert holds the window open: without it the outcome is
 * decided by scheduling, and a test that passes fifteen times in sixteen is worse
 * than none. The sleep is after each callback's lookup, so both find nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase, CLONE_HOOK_MS } from '@purlay/db';
import { createApp } from './app';
import { NOW, testDependencies } from '../../testing/doubles';
import {
  aGitHubAuth,
  aGitHubFor,
  aGitHubPerson,
  cookiesFrom,
  returnFromGitHub,
  signInWithGitHub,
  startGitHubSignIn,
  type GitHubStub,
  type StartedSignIn,
} from '../../testing/github-sign-in';
import { RETRY_COOKIE } from '../../platform/cookies';
import { fixedClock } from '../../platform/clock';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function hold_window() returns trigger language plpgsql as
    $$ begin perform pg_sleep(0.3); return new; end $$
  `.execute(cloned.db);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
});

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);

/** A server signing in through this GitHub, on the clone. */
const aServer = (github: GitHubStub): ReturnType<typeof createApp> =>
  createApp(
    testDependencies({
      database: cloned.db,
      clock,
      auth: aGitHubAuth(cloned.db, github.fetch, { baseUrl: ORIGIN }),
    }),
  );

/** Both callbacks at once, with the user's insert held open so both find no account. */
const race = async (
  app: ReturnType<typeof createApp>,
  tabs: readonly StartedSignIn[],
): Promise<Response[]> => {
  await sql`create trigger hold before insert on users for each row execute function hold_window()`.execute(
    cloned.db,
  );
  try {
    return await Promise.all(tabs.map(async (tab) => await returnFromGitHub(app, ORIGIN, tab)));
  } finally {
    await sql`drop trigger hold on users`.execute(cloned.db);
  }
};

const counts = async (
  email: string,
): Promise<{ users: number; accounts: number; sessions: number }> => {
  const users = await cloned.db
    .selectFrom('users')
    .select('id')
    .where('email', '=', email)
    .execute();
  const ids = users.map((user) => user.id);
  const accounts =
    ids.length === 0
      ? []
      : await cloned.db.selectFrom('accounts').select('id').where('user_id', 'in', ids).execute();
  const sessions =
    ids.length === 0
      ? []
      : await cloned.db.selectFrom('sessions').select('id').where('user_id', 'in', ids).execute();
  return { users: users.length, accounts: accounts.length, sessions: sessions.length };
};

describe('integration: two callbacks for one GitHub account', () => {
  test('both tabs end signed in: two sessions, one user, one account', async () => {
    const person = aGitHubPerson(`race-${crypto.randomUUID().slice(0, 8)}`);
    const github = aGitHubFor(person);
    const app = aServer(github);

    // Each callback needs its own state, so start both before racing the callbacks.
    const one = await startGitHubSignIn(app, ORIGIN, github);
    const two = await startGitHubSignIn(app, ORIGIN, github);
    const answers = await race(app, [one, two]);
    const locations = answers.map((answer) => answer.headers.get('location'));
    expect(locations.sort()).toEqual([ORIGIN, `${ORIGIN}/auth/github`].sort());

    // The tab sent round goes where it was sent, carrying what it was given, and GitHub authorises.
    const lost = answers.find(
      (answer) => answer.headers.get('location') === `${ORIGIN}/auth/github`,
    );
    const tab = lost === answers[0] ? one : two;
    const carried = [tab.cookie, cookiesFrom(lost ?? new Response())].filter(Boolean).join('; ');
    const again = await startGitHubSignIn(app, ORIGIN, github, carried);
    const back = await returnFromGitHub(app, ORIGIN, again);
    expect(back.headers.get('location')).toBe(ORIGIN);
    // Signed in, the marker is spent.
    expect(back.headers.getSetCookie().some((c) => c.startsWith(`${RETRY_COOKIE}=;`))).toBe(true);

    expect(await counts(person.email)).toEqual({ users: 1, accounts: 1, sessions: 2 });
  });

  test('a tab already sent round once that loses again is failed, never sent round again', async () => {
    const person = aGitHubPerson(`race-${crypto.randomUUID().slice(0, 8)}`);
    const github = aGitHubFor(person);
    const app = aServer(github);
    const marker = `${RETRY_COOKIE}=1`;
    const one = await startGitHubSignIn(app, ORIGIN, github, marker);
    const two = await startGitHubSignIn(app, ORIGIN, github, marker);
    const locations = (await race(app, [one, two])).map((answer) => answer.headers.get('location'));
    expect(locations.sort()).toEqual([ORIGIN, `${ORIGIN}/sign-in?error=failed`].sort());
    expect(await counts(person.email)).toEqual({ users: 1, accounts: 1, sessions: 1 });
  });

  test('a sign-up that fails for any other reason is failed, and nobody is sent round', async () => {
    const person = aGitHubPerson(`race-${crypto.randomUUID().slice(0, 8)}`);
    const github = aGitHubFor(person);
    const app = aServer(github);
    await sql`
      create function refuse_users() returns trigger language plpgsql as
      $$ begin raise exception 'refused by the test'; end $$
    `.execute(cloned.db);
    await sql`create trigger refuse before insert on users for each row execute function refuse_users()`.execute(
      cloned.db,
    );
    try {
      const refused = await signInWithGitHub(app, ORIGIN, github);
      expect(refused.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=failed`);
    } finally {
      await sql`drop trigger refuse on users`.execute(cloned.db);
      await sql`drop function refuse_users()`.execute(cloned.db);
    }
    expect(await counts(person.email)).toEqual({ users: 0, accounts: 0, sessions: 0 });
  });
});
