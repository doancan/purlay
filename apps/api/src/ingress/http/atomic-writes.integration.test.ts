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
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { createApp } from './app';
import { aSignedInUser } from './fixtures';
import { NOW, aGitHubAccount, testDependencies } from './testing';
import { fixedClock } from '../../platform/clock';
import { aUniqueSlug } from '../../testing/users';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  await sql`
    create function refuse_insert() returns trigger language plpgsql as
    $$ begin raise exception 'refused by the test: %', tg_table_name; end $$
  `.execute(cloned.db);
});

afterAll(async () => {
  await cloned.drop();
});

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

const app = (github = testDependencies().github): ReturnType<typeof createApp> =>
  createApp(testDependencies({ database: cloned.db, clock, github }));

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

  test('a sign-in whose session fails to write leaves no account behind', async () => {
    const login = `atomic-${crypto.randomUUID().slice(0, 8)}`;
    const email = `${login}@example.test`;
    const github = aGitHubAccount(
      {
        id: Math.floor(Math.random() * 1_000_000_000) + 1_000_000,
        login,
        name: null,
        avatarUrl: null,
      },
      [{ email, primary: true, verified: true }],
    );

    const signIn = async (): Promise<Response> => {
      const started = await app(github).handle(new Request(`${ORIGIN}/auth/github`));
      const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
      const cookie = (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      return await app(github).handle(
        new Request(`${ORIGIN}/auth/github/callback?code=a-valid-code&state=${state}`, {
          headers: { cookie },
        }),
      );
    };

    await whileRefusingInserts('sessions', async () => {
      expect((await signIn()).status).toBe(500);
    });
    const left = await cloned.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .execute();
    expect(left).toEqual([]);

    expect((await signIn()).status).toBe(302);
  });
});
