/**
 * The workspace endpoints, driven through real requests.
 *
 * Two of these are mandatory rather than chosen. `ARCHITECTURE.md` §10 requires
 * **every** workspace-scoped endpoint to carry a cross-tenant test asserting
 * `404` — no exceptions — because tenant isolation is the one defect class here
 * that is silent, unbounded and unrecoverable (D-21).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { ErrorResponse } from '@purlay/types';
import { createApp } from './app';
import { testDependencies } from './testing';
import { issueSession } from '../../modules/auth/sessions';
import { fixedClock } from '../../platform/clock';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

const addUser = async (db: Executor, name: string): Promise<string> => {
  const row = await db
    .insertInto('users')
    .values({ email: `${name}@example.test`, username: name, display_name: name })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

/** A signed-in caller: a user, and the cookie a browser would send for them. */
const signedIn = async (
  db: Executor,
  name: string,
): Promise<{ userId: string; cookie: string }> => {
  const userId = await addUser(db, name);
  const { token } = await issueSession(db, clock, userId, 30);
  return { userId, cookie: `purlay_session=${token}` };
};

const call = async (
  db: Executor,
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const aWorkspace = async (db: Executor, cookie: string, slug: string): Promise<{ id: string }> => {
  const response = await call(db, 'POST', '/api/workspaces', {
    cookie,
    body: { name: slug, slug },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
};

describe('integration: workspaces', () => {
  test('creating one makes the creator its owner', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'ws-alice');
      const created = await aWorkspace(db, alice.cookie, 'acme');

      const memberships = await db
        .selectFrom('workspace_members')
        .selectAll()
        .where('workspace_id', '=', created.id)
        .execute();
      // I-2: a workspace exists with at least one owner from the moment it exists.
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.role).toBe('owner');
      expect(memberships[0]?.user_id).toBe(alice.userId);
    });
  });

  test('the slug is an address, so taking one twice is refused', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'ws-first');
      const bob = await signedIn(db, 'ws-second');
      await aWorkspace(db, alice.cookie, 'taken');

      const response = await call(db, 'POST', '/api/workspaces', {
        cookie: bob.cookie,
        body: { name: 'Also Taken', slug: 'taken' },
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'WORKSPACE_SLUG_TAKEN' } });
    });
  });

  test('a body that does not match the contract is refused with its fields, and nothing else', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'ws-typo');
      const response = await call(db, 'POST', '/api/workspaces', {
        cookie: alice.cookie,
        body: { name: '', slug: 'Not A Slug', surprise: 'hunter2' },
      });

      expect(response.status).toBe(400);
      const body: unknown = await response.json();
      expect(Value.Check(ErrorResponse, body)).toBe(true);
      expect(body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

      const text = JSON.stringify(body);
      // Neither the submitted value nor the schema crosses the boundary.
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('minLength');
      expect(text).not.toContain('pattern');
    });
  });

  test('listing returns only your own memberships', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'ws-mine');
      const bob = await signedIn(db, 'ws-theirs');
      await aWorkspace(db, alice.cookie, 'mine');
      await aWorkspace(db, bob.cookie, 'theirs');

      const response = await call(db, 'GET', '/api/workspaces', { cookie: alice.cookie });
      const memberships = (await response.json()) as {
        workspace: { slug: string };
        role: string;
      }[];
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.workspace.slug).toBe('mine');
      expect(memberships[0]?.role).toBe('owner');
    });
  });

  test('members are visible to members, and never carry an email address', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'ws-member');
      const created = await aWorkspace(db, alice.cookie, 'visible');

      const response = await call(db, 'GET', `/api/workspaces/${created.id}/members`, {
        cookie: alice.cookie,
      });
      expect(response.status).toBe(200);
      const members: unknown = await response.json();
      expect(JSON.stringify(members)).not.toContain('@example.test');
      expect(members).toMatchObject([{ role: 'owner', user: { username: 'ws-member' } }]);
    });
  });

  /**
   * Mandatory, per `ARCHITECTURE.md` §10: every workspace-scoped endpoint carries
   * one of these. A `403` would confirm the workspace exists, which is itself the
   * disclosure (D-21).
   */
  for (const path of ['', '/members'] as const) {
    test(`GET /api/workspaces/:id${path} answers 404 across a tenant boundary, never 403`, async () => {
      await withRollback(async (db) => {
        const owner = await signedIn(db, `x-owner${path.replace('/', '-')}`);
        const stranger = await signedIn(db, `x-stranger${path.replace('/', '-')}`);
        const theirs = await aWorkspace(db, owner.cookie, `closed${path.replace('/', '-')}`);

        const response = await call(db, 'GET', `/api/workspaces/${theirs.id}${path}`, {
          cookie: stranger.cookie,
        });

        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body).toMatchObject({ error: { code: 'WORKSPACE_NOT_FOUND' } });

        // And it is the same answer as for a workspace that does not exist at all.
        const missing = await call(
          db,
          'GET',
          `/api/workspaces/00000000-0000-4000-8000-000000000000${path}`,
          { cookie: stranger.cookie },
        );
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual(body);
      });
    });
  }

  test('every one of these endpoints requires a session', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'ws-anon');
      const created = await aWorkspace(db, alice.cookie, 'private');

      for (const [method, path] of [
        ['GET', '/api/workspaces'],
        ['POST', '/api/workspaces'],
        ['GET', `/api/workspaces/${created.id}`],
        ['GET', `/api/workspaces/${created.id}/members`],
      ] as const) {
        const response = await call(db, method, path, {
          ...(method === 'POST' ? { body: { name: 'x', slug: 'x' } } : {}),
        });
        expect(response.status).toBe(401);
      }
    });
  });
});
