/**
 * Who may make a workspace (D-155), through real requests: what `GET /api/me` says, and what
 * `POST /api/workspaces` does, under each value of `WORKSPACE_CREATORS`.
 *
 * Inside a transaction that is rolled back (D-46). The first run of an instance is made by emptying
 * `workspaces` inside it, which the rollback puts back.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import { createApp } from './app';
import { testConfig, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(new Date('2026-10-19T12:00:00.000Z'));

/** The test configuration with `WORKSPACE_CREATORS` set to this, or not set at all. */
const configured = (creators: string | undefined): Config => {
  const config: Config = { ...testConfig() };
  if (creators === undefined) delete config.WORKSPACE_CREATORS;
  else config.WORKSPACE_CREATORS = creators;
  return config;
};

const call = async (
  db: Executor,
  creators: string | undefined,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> =>
  await createApp(
    testDependencies({
      database: db,
      clock,
      config: configured(creators),
    }),
  ).handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** What `/api/me` says, and what a create then does. */
const tryIt = async (
  db: Executor,
  creators: string | undefined,
  person: SignedInUser,
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

/** A person who signed in with GitHub: their username is the login GitHub gave. */
const withGitHub = async (db: Executor, person: SignedInUser): Promise<SignedInUser> => {
  nextGitHubId += 1;
  await db
    .updateTable('users')
    .set({ github_id: String(nextGitHubId) })
    .where('id', '=', person.userId)
    .execute();
  return person;
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
