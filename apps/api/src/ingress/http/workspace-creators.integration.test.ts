/**
 * Who may make a workspace (D-155), through real requests: what `GET /api/me` says, and what
 * `POST /api/workspaces` does, under each rule the server's setting can hold (D-179 §6) — written as
 * `WORKSPACE_CREATORS` spells it, the seed it is imported from, and read by the application itself.
 *
 * Inside a transaction that is rolled back (D-46). The first run of an instance is made by emptying
 * `workspaces` inside it, which the rollback puts back.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { createApp } from './app';
import { creatorsFromTheSetting, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { credentialCipher } from '../../platform/crypto';
import { saveSettings } from '../../modules/setup/settings';
import { workspaceCreatorsOf } from '../../modules/workspaces/creators';
import { SESSION_COOKIE } from '../../platform/cookies';
import { recordGitHubSignIn } from '../../modules/auth/identity';
import { aSession, aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(new Date('2026-10-19T12:00:00.000Z'));

/** The server's setting made what `WORKSPACE_CREATORS` says, or the default for it unset. */
const configured = async (db: Executor, creators: string | undefined): Promise<void> => {
  await saveSettings(db, credentialCipher(DEVELOPMENT_ENCRYPTION_KEY), clock, {
    workspaceCreators: workspaceCreatorsOf(creators),
  });
};

const call = async (
  db: Executor,
  creators: string | undefined,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> => {
  await configured(db, creators);
  return await createApp(creatorsFromTheSetting(testDependencies({ database: db, clock }))).handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
};

/** What `/api/me` says, and what a create then does. */
const tryIt = async (
  db: Executor,
  creators: string | undefined,
  person: Pick<SignedInUser, 'cookie'>,
): Promise<{ may: boolean; status: number; code: string | undefined }> => {
  const me = (await (await call(db, creators, 'GET', '/api/me', person.cookie)).json()) as {
    mayCreateWorkspace: boolean;
  };
  const created = await call(db, creators, 'POST', '/api/workspaces', person.cookie, {
    name: 'Acme',
    slug: aUniqueSlug('made'),
  });
  const answer = (await created.json()) as { error?: { code: string } };
  return { may: me.mayCreateWorkspace, status: created.status, code: answer.error?.code };
};

let nextGitHubId = 9_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

/** A person who signed in with GitHub, whose login GitHub gave as their username. */
const withGitHub = async (db: Executor, person: SignedInUser): Promise<SignedInUser> => {
  nextGitHubId += 1;
  await db
    .updateTable('users')
    .set({ github_id: String(nextGitHubId), github_login: person.username })
    .where('id', '=', person.userId)
    .execute();
  return person;
};

/** A login nobody in the database has: lower case, as GitHub's are compared. */
const aLogin = (name: string): string => `${name}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Signs in through GitHub as this id and login, the way the library's callback leaves the database:
 * the account made if this id has none, then what a GitHub sign-in writes (`recordGitHubSignIn`);
 * answers the cookie.
 */
const signedInWithGitHub = async (db: Executor, id: number, login: string): Promise<string> => {
  const githubId = String(id);
  const known = await db
    .selectFrom('users')
    .select('id')
    .where('github_id', '=', githubId)
    .executeTakeFirst();
  const made =
    known ??
    (await db
      .insertInto('users')
      .values({
        github_id: githubId,
        email: `${githubId}@users.noreply.github.test`,
        username: `pending-${githubId}`,
        display_name: login,
      })
      .returning('id')
      .executeTakeFirstOrThrow());
  const { userId } = await recordGitHubSignIn(db, clock, {
    userId: made.id,
    profile: { id, login, name: null, avatarUrl: null },
    made: known === undefined,
  });
  const { token } = await aSession(db, clock, userId, 30);
  return `${SESSION_COOKIE}=${token}`;
};

/** A person who signed in by an email link at this address. */
const signedInByEmail = async (db: Executor, username: string): Promise<string> => {
  const user = await db
    .insertInto('users')
    .values({ email: `${username}@stranger.test`, username, display_name: username })
    .returning('id')
    .executeTakeFirstOrThrow();
  const { token } = await aSession(db, clock, user.id, 30);
  return `${SESSION_COOKIE}=${token}`;
};

const ALLOWED = { may: true, status: 201, code: undefined };
const REFUSED = { may: false, status: 403, code: 'FORBIDDEN' };

describe('integration: who may make a workspace (D-155)', () => {
  test('a login on the list may, in any case; one not on it may not, and nothing is made', async () => {
    await withRollback(async (db) => {
      const listed = await withGitHub(db, await aSignedInUser(db, clock, 'wc-listed'));
      const other = await withGitHub(db, await aSignedInUser(db, clock, 'wc-other'));
      const creators = `someone-else, ${listed.username.toUpperCase()}`;

      expect(await tryIt(db, creators, listed)).toEqual(ALLOWED);
      expect(await tryIt(db, creators, other)).toEqual(REFUSED);
      const made = await db
        .selectFrom('workspaces')
        .select('id')
        .where('created_by', '=', other.userId)
        .execute();
      expect(made).toEqual([]);
    });
  });

  test('an account made by an email link is not the login its username spells', async () => {
    await withRollback(async (db) => {
      // No GitHub id: the name came from an address, which anybody can own.
      const byEmail = await aSignedInUser(db, clock, 'wc-email');
      expect(await tryIt(db, byEmail.username, byEmail)).toEqual(REFUSED);
    });
  });

  test('a stranger who took the listed name by email first does not take the right from its GitHub owner', async () => {
    await withRollback(async (db) => {
      const login = aLogin('wc-alice');
      // The stranger signs in by an email link as <login>@…, and is named <login>.
      const stranger = await signedInByEmail(db, login);
      // The listed person signs in with GitHub after, and is stored as <login>-1.
      nextGitHubId += 1;
      const alice = await signedInWithGitHub(db, nextGitHubId, login);
      const stored = await db
        .selectFrom('users')
        .select('username')
        .where('github_id', '=', String(nextGitHubId))
        .executeTakeFirstOrThrow();
      expect(stored.username).toBe(`${login}-1`);

      expect(await tryIt(db, login, { cookie: alice })).toEqual(ALLOWED);
      expect(await tryIt(db, login, { cookie: stranger })).toEqual(REFUSED);
    });
  });

  test('a name given a suffix here is not a login: listing it lets nobody in', async () => {
    await withRollback(async (db) => {
      const login = aLogin('wc-bob');
      await signedInByEmail(db, login);
      nextGitHubId += 1;
      const bob = await signedInWithGitHub(db, nextGitHubId, login);
      // GitHub's bob is stored as <login>-1; a listed `<login>-1` names a GitHub account nobody here has.
      expect(await tryIt(db, `${login}-1`, { cookie: bob })).toEqual(REFUSED);
    });
  });

  test('the login is GitHub’s latest: a rename moves the right, and a login taken by another account leaves the old one', async () => {
    await withRollback(async (db) => {
      const before = aLogin('wc-old');
      const after = aLogin('wc-new');
      nextGitHubId += 1;
      const renamedId = nextGitHubId;
      const renamed = await signedInWithGitHub(db, renamedId, before);
      expect(await tryIt(db, before, { cookie: renamed })).toEqual(ALLOWED);

      // Renamed at GitHub, and the freed login taken by somebody else, who signs in first.
      nextGitHubId += 1;
      const taker = await signedInWithGitHub(db, nextGitHubId, before);
      expect(await tryIt(db, before, { cookie: taker })).toEqual(ALLOWED);
      expect(await tryIt(db, before, { cookie: renamed })).toEqual(REFUSED);

      // The renamed person signs in again, under the login GitHub now gives them.
      const again = await signedInWithGitHub(db, renamedId, after);
      expect(await tryIt(db, after, { cookie: again })).toEqual(ALLOWED);
      expect(await tryIt(db, before, { cookie: again })).toEqual(REFUSED);
    });
  });

  test('`*` lets anybody signed in', async () => {
    await withRollback(async (db) => {
      const anybody = await aSignedInUser(db, clock, 'wc-anybody');
      expect(await tryIt(db, '*', anybody)).toEqual(ALLOWED);
    });
  });

  test('unset, the first person to sign in makes the first workspace, and nobody makes a second', async () => {
    await withRollback(async (db) => {
      await sql`truncate workspaces cascade`.execute(db);
      const first = await aSignedInUser(db, clock, 'wc-first');
      const later = await aSignedInUser(db, clock, 'wc-later');
      // The first to sign in: earlier than every account the database already holds.
      await db
        .updateTable('users')
        .set({ created_at: new Date('2000-01-01T00:00:00.000Z') })
        .where('id', '=', first.userId)
        .execute();

      expect(await tryIt(db, undefined, later)).toEqual(REFUSED);
      expect(await tryIt(db, undefined, first)).toEqual(ALLOWED);
      // The instance has its workspace now: the next is an invitation away, even for its owner.
      expect(await tryIt(db, undefined, first)).toEqual(REFUSED);
    });
  });

  test('unset, an instance that has a workspace lets nobody make another', async () => {
    await withRollback(async (db) => {
      const earliest = await aSignedInUser(db, clock, 'wc-earliest');
      await db
        .updateTable('users')
        .set({ created_at: new Date('2000-01-01T00:00:00.000Z') })
        .where('id', '=', earliest.userId)
        .execute();
      // Made directly, as an instance already set up would have it.
      await db
        .insertInto('workspaces')
        .values({ name: 'Old', slug: aUniqueSlug('old'), created_by: earliest.userId })
        .execute();
      expect(await tryIt(db, undefined, earliest)).toEqual(REFUSED);
    });
  });
});
