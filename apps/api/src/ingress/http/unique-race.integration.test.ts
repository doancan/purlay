/**
 * Two requests for one name at the same moment: one wins, the other is told `409`.
 *
 * Both check, both find the name free, both insert — and the index is the only
 * thing that can tell them apart (`createWorkspace` says so in a comment). Until
 * the violation was mapped, the loser answered `500` (#233).
 *
 * On a cloned database with two real connections, because inside the harness's
 * single transaction there is no second request to race (D-46, D-77). A trigger
 * that sleeps before the insert holds the window open: without it the race is
 * won or lost by scheduling, and a test that passes fifteen times in sixteen is
 * worse than none. The sleep sits *after* each request's existence check, so both
 * pass the check before either commits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, sql, type ClonedDatabase } from '@purlay/db';
import { createApp } from './app';
import { aSignedInUser } from './fixtures';
import { NOW, testDependencies } from './testing';
import { fixedClock } from '../../platform/clock';
import { aUniqueSlug } from '../../testing/users';

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

const clock = fixedClock(NOW);

const post = async (path: string, cookie: string, body: unknown): Promise<Response> =>
  await createApp(testDependencies({ database: cloned.db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const codeOf = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null && 'error' in body ? body.error : body;
};

describe('integration: a unique race is a 409, never a 500', () => {
  test('two workspaces created with one slug at once', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'race-a');
    const bob = await aSignedInUser(cloned.db, clock, 'race-b');
    const slug = aUniqueSlug('race');
    await sql`create trigger hold before insert on workspaces for each row execute function hold_window()`.execute(
      cloned.db,
    );

    try {
      const [first, second] = await Promise.all([
        post('/api/workspaces', alice.cookie, { name: 'One', slug }),
        post('/api/workspaces', bob.cookie, { name: 'Two', slug }),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const loser = first.status === 409 ? first : second;
      expect(await codeOf(loser)).toMatchObject({ code: 'WORKSPACE_SLUG_TAKEN' });
    } finally {
      await sql`drop trigger hold on workspaces`.execute(cloned.db);
    }

    // The loser left nothing: one workspace holds the slug, and it has its owner.
    const rows = await cloned.db
      .selectFrom('workspaces')
      .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
      .select('workspace_members.role')
      .where('workspaces.slug', '=', slug)
      .execute();
    expect(rows.map((row) => row.role)).toEqual(['owner']);
  });

  test('two channels created with one name at once', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'race-c');
    const created = await post('/api/workspaces', alice.cookie, {
      name: 'Race',
      slug: aUniqueSlug('race-ch'),
    });
    const workspace = (await created.json()) as { id: string };
    const path = `/api/workspaces/${workspace.id}/channels`;
    await sql`create trigger hold before insert on channels for each row execute function hold_window()`.execute(
      cloned.db,
    );

    try {
      const [first, second] = await Promise.all([
        post(path, alice.cookie, { name: 'general' }),
        post(path, alice.cookie, { name: 'General' }),
      ]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      const loser = first.status === 409 ? first : second;
      expect(await codeOf(loser)).toMatchObject({ code: 'CHANNEL_NAME_TAKEN' });
    } finally {
      await sql`drop trigger hold on channels`.execute(cloned.db);
    }
  });
});
