/**
 * A request that writes more than once either writes everything or nothing.
 *
 * On a cloned database, because committing is the behaviour under test: inside
 * the harness's rolled-back transaction a half-finished request is cleaned up by
 * the rollback that ends every test, so the suite cannot tell an atomic service
 * from a broken one (D-46). The clone is this file's own and is dropped after it,
 * so nothing is left behind and nothing depends on another test's state.
 *
 * Each test makes the *second* write fail, with a trigger that refuses the insert
 * — the failure a constraint, a deadlock or a dropped connection would be — and
 * asserts that the first is gone. A check that has never seen a rollback is a
 * check that has not been tested, so the control case at the end proves the
 * trigger is what stops the write and that the same request commits without it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { createApp } from './app';
import { aSignedInUser } from '../../testing/signed-in';
import { NOW, testDependencies } from '../../testing/doubles';
import {
  aGitHubAuth,
  aGitHubFor,
  aGitHubPerson,
  signInWithGitHub,
  type GitHubPerson,
} from '../../testing/github-sign-in';
import { fixedClock } from '../../platform/clock';
import { aUniqueSlug } from '../../testing/users';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function refuse_insert() returns trigger language plpgsql as
    $$ begin raise exception 'refused by the test: %', tg_table_name; end $$
  `.execute(cloned.db);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);

/** Makes every insert into the table fail, for the duration of the body. */
const whileRefusingInserts = async (table: string, body: () => Promise<void>): Promise<void> => {
  await sql`create trigger refuse before insert on ${sql.id(table)} for each row execute function refuse_insert()`.execute(
    cloned.db,
  );
  try {
    await body();
  } finally {
    await sql`drop trigger refuse on ${sql.id(table)}`.execute(cloned.db);
  }
};

const app = (): ReturnType<typeof createApp> =>
  createApp(testDependencies({ database: cloned.db, clock }));

const postJson = async (path: string, cookie: string, body: unknown): Promise<Response> =>
  await app().handle(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

describe('integration: multi-write requests are atomic', () => {
  test('a workspace whose owner row fails to write does not exist, and its slug is free', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'atomic-ws');
    const slug = aUniqueSlug('atomic-ws');

    await whileRefusingInserts('workspace_members', async () => {
      const response = await postJson('/api/workspaces', alice.cookie, { name: 'Acme', slug });
      expect(response.status).toBe(500);
    });

    const left = await cloned.db
      .selectFrom('workspaces')
      .select('id')
      .where('slug', '=', slug)
      .execute();
    expect(left).toEqual([]);

    // The address is usable: the retry a person would make succeeds.
    const retry = await postJson('/api/workspaces', alice.cookie, { name: 'Acme', slug });
    expect(retry.status).toBe(201);
  });

  test('a channel whose creator row fails to write does not exist, and its name is free', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'atomic-ch');
    const created = await postJson('/api/workspaces', alice.cookie, {
      name: 'Atomic',
      slug: aUniqueSlug('atomic-ch'),
    });
    const workspace = (await created.json()) as { id: string };
    const name = `atomic-${crypto.randomUUID().slice(0, 6)}`;

    await whileRefusingInserts('channel_members', async () => {
      const response = await postJson(`/api/workspaces/${workspace.id}/channels`, alice.cookie, {
        name,
      });
      expect(response.status).toBe(500);
    });

    const left = await cloned.db
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', workspace.id)
      .where('name', '=', name)
      .execute();
    expect(left).toEqual([]);

    const retry = await postJson(`/api/workspaces/${workspace.id}/channels`, alice.cookie, {
      name,
    });
    expect(retry.status).toBe(201);
  });

  test('a join whose record fails to write leaves nobody in, and the link still opens (D-115)', async () => {
    const owner = await aSignedInUser(cloned.db, clock, 'atomic-inv');
    const joiner = await aSignedInUser(cloned.db, clock, 'atomic-joiner');
    const created = await postJson('/api/workspaces', owner.cookie, {
      name: 'Invited',
      slug: aUniqueSlug('atomic-inv'),
    });
    const workspace = (await created.json()) as { id: string };
    const made = await postJson(`/api/workspaces/${workspace.id}/invitations`, owner.cookie, {});
    const { token } = (await made.json()) as { token: string };

    await whileRefusingInserts('audit_log', async () => {
      const response = await postJson('/api/invitations/accept', joiner.cookie, { token });
      expect(response.status).toBe(500);
    });
    const left = await cloned.db
      .selectFrom('workspace_members')
      .select('id')
      .where('workspace_id', '=', workspace.id)
      .where('user_id', '=', joiner.userId)
      .execute();
    expect(left).toEqual([]);

    const retry = await postJson('/api/invitations/accept', joiner.cookie, { token });
    expect(retry.status).toBe(200);
  });

  /** A GitHub sign-in of this person through the library, as a browser makes it. */
  const signInAs = async (person: GitHubPerson): Promise<Response> => {
    const github = aGitHubFor(person);
    return await signInWithGitHub(
      createApp(
        testDependencies({
          database: cloned.db,
          clock,
          auth: aGitHubAuth(cloned.db, github.fetch, { baseUrl: ORIGIN }),
        }),
      ),
      ORIGIN,
      github,
    );
  };

  const accountsOf = async (email: string): Promise<{ id: string }[]> =>
    await cloned.db.selectFrom('users').select('id').where('email', '=', email).execute();

  test('a sign-up whose account row fails to write leaves no user behind (D-179)', async () => {
    const person = aGitHubPerson(`atomic-${crypto.randomUUID().slice(0, 8)}`);
    await whileRefusingInserts('accounts', async () => {
      // The callback is a browser's, so the failure comes back as the sign-in screen (D-121).
      const refused = await signInAs(person);
      expect(refused.status).toBe(302);
      expect(refused.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=failed`);
    });
    expect(await accountsOf(person.email)).toEqual([]);

    const signedIn = await signInAs(person);
    expect(signedIn.headers.get('location')).toBe(ORIGIN);
    expect(await accountsOf(person.email)).toHaveLength(1);
  });

  // The library commits the account before it makes the session, so a session that fails to write
  // leaves the account: what must hold is that the next attempt signs that same account in.
  test('a sign-in whose session fails to write is sent back, and the next one is the same account', async () => {
    const person = aGitHubPerson(`atomic-${crypto.randomUUID().slice(0, 8)}`);
    await whileRefusingInserts('sessions', async () => {
      const refused = await signInAs(person);
      expect(refused.status).toBe(302);
      expect(refused.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=failed`);
    });
    const signedIn = await signInAs(person);
    expect(signedIn.headers.get('location')).toBe(ORIGIN);
    const accounts = await accountsOf(person.email);
    expect(accounts).toHaveLength(1);
    const user = await cloned.db
      .selectFrom('users')
      .select(['github_id', 'github_login', 'github_connected_at'])
      .where('email', '=', person.email)
      .executeTakeFirstOrThrow();
    // Still an account GitHub made, never one "connected" (0046, D-176).
    expect(user).toEqual({
      github_id: String(person.id),
      github_login: person.login,
      github_connected_at: null,
    });
  });

  /** Makes every update of `users` fail, for the duration of the body. */
  const whileRefusingUserUpdates = async (
    body: () => Promise<void>,
    when = 'true',
  ): Promise<void> => {
    await sql
      .raw(
        `create trigger refuse_update before update on users for each row when (${when}) execute function refuse_insert()`,
      )
      .execute(cloned.db);
    try {
      await body();
    } finally {
      await sql`drop trigger refuse_update on users`.execute(cloned.db);
    }
  };

  const githubColumnsOf = async (email: string): Promise<Record<string, unknown>> =>
    await cloned.db
      .selectFrom('users')
      .select(['github_id', 'github_login', 'github_connected_at', 'display_name'])
      .where('email', '=', email)
      .executeTakeFirstOrThrow();

  test('an account GitHub made stays one when what follows its making fails (D-176)', async () => {
    const person = aGitHubPerson(`atomic-${crypto.randomUUID().slice(0, 8)}`);
    await whileRefusingUserUpdates(async () => {
      const refused = await signInAs(person);
      expect(refused.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=failed`);
    });
    // Made in the library's own transaction, with the account: GitHub's id and login are already
    // there, so nothing after it can leave the account looking like one made by email.
    expect(await githubColumnsOf(person.email)).toMatchObject({
      github_id: String(person.id),
      github_login: person.login,
      github_connected_at: null,
    });
    expect((await signInAs(person)).headers.get('location')).toBe(ORIGIN);
    expect(await githubColumnsOf(person.email)).toMatchObject({
      github_id: String(person.id),
      github_connected_at: null,
      display_name: 'Ada Lovelace',
    });
  });

  test('a refresh whose second statement fails leaves nothing half-written', async () => {
    const person = aGitHubPerson(`atomic-${crypto.randomUUID().slice(0, 8)}`);
    expect((await signInAs(person)).headers.get('location')).toBe(ORIGIN);
    const renamed = {
      ...person,
      login: `renamed-${crypto.randomUUID().slice(0, 8)}`,
      name: 'New Name',
    };
    // Only the statement that writes the new login fails — after the names were written.
    await whileRefusingUserUpdates(async () => {
      const refused = await signInAs(renamed);
      expect(refused.headers.get('location')).toBe(`${ORIGIN}/sign-in?error=failed`);
    }, `new.github_login is distinct from old.github_login and new.github_login is not null`);
    expect(await githubColumnsOf(person.email)).toMatchObject({
      github_login: person.login,
      display_name: 'Ada Lovelace',
      github_connected_at: null,
    });
  });
});
