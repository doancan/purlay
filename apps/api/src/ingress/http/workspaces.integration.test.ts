/**
 * The workspace endpoints, driven through real requests.
 *
 * Their cross-tenant tests are not here: every workspace-scoped endpoint is
 * crossed in `cross-tenant.integration.test.ts`, from a list the build checks
 * against `API.md` (D-21, D-63).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { ErrorResponse } from '@purlay/types';
import { createApp } from './app';
import { testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { AppError } from '../../platform/errors';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { renameWorkspace } from '../../modules/workspaces/workspaces';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

/** A signed-in caller: a user, and the cookie a browser would send for them. */
const signedIn = async (db: Executor, name: string): Promise<SignedInUser> =>
  await aSignedInUser(db, clock, name);

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

const aWorkspace = async (
  db: Executor,
  cookie: string,
  name: string,
): Promise<{ id: string; slug: string }> => {
  const response = await call(db, 'POST', '/api/workspaces', {
    cookie,
    body: { name, slug: aUniqueSlug(name) },
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; slug: string };
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
      const taken = await aWorkspace(db, alice.cookie, 'taken');

      const response = await call(db, 'POST', '/api/workspaces', {
        cookie: bob.cookie,
        body: { name: 'Also Taken', slug: taken.slug },
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
      const mine = await aWorkspace(db, alice.cookie, 'mine');
      await aWorkspace(db, bob.cookie, 'theirs');

      const response = await call(db, 'GET', '/api/workspaces', { cookie: alice.cookie });
      const memberships = (await response.json()) as {
        workspace: { slug: string };
        role: string;
      }[];
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.workspace.slug).toBe(mine.slug);
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
      expect(members).toMatchObject([{ role: 'owner', user: { username: alice.username } }]);
    });
  });

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

describe('integration: who am I', () => {
  test('returns the caller with their own email, and their memberships', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'me-alice');
      const acme = await aWorkspace(db, alice.cookie, 'me-acme');

      const response = await call(db, 'GET', '/api/me', { cookie: alice.cookie });
      expect(response.status).toBe(200);

      const me = (await response.json()) as {
        user: { id: string; email: string; username: string };
        memberships: { role: string; workspace: { slug: string } }[];
      };
      expect(me.user.id).toBe(alice.userId);
      expect(me.user.email).toBe(alice.email);
      expect(me.memberships).toHaveLength(1);
      expect(me.memberships[0]?.role).toBe('owner');
      expect(me.memberships[0]?.workspace.slug).toBe(acme.slug);
    });
  });

  /**
   * The email is the identity anchor and belongs to exactly one person. Listing
   * members must never carry it, and this is the only shape that does.
   */
  test('another member cannot reach this email through the member list', async () => {
    await withRollback(async (db) => {
      const alice = await signedIn(db, 'me-owner');
      const bob = await signedIn(db, 'me-other');
      const workspace = await aWorkspace(db, alice.cookie, 'me-shared');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: workspace.id, user_id: bob.userId })
        .execute();

      const members = await call(db, 'GET', `/api/workspaces/${workspace.id}/members`, {
        cookie: bob.cookie,
      });
      const listed = JSON.stringify(await members.json());
      // The owner is in the list — so the address being absent from it means
      // something, rather than that the list was empty.
      expect(listed).toContain(alice.username);
      expect(listed).not.toContain(alice.email);
    });
  });

  test('without a session it is 401, like every other /api endpoint', async () => {
    await withRollback(async (db) => {
      expect((await call(db, 'GET', '/api/me')).status).toBe(401);
    });
  });
});

describe('integration: renaming a workspace (D-124)', () => {
  const trail = async (db: Executor, workspaceId: string): Promise<Record<string, unknown>[]> =>
    await db
      .selectFrom('audit_log')
      .select(['action', 'actor_user_id', 'target_type', 'target_id', 'metadata'])
      .where('workspace_id', '=', workspaceId)
      .where('action', '=', 'workspace.renamed')
      .execute();

  test('an owner renames it: the name moves, the address does not, and the trail says from what to what', async () => {
    await withRollback(async (db) => {
      const owner = await signedIn(db, 'rn-owner');
      const made = await aWorkspace(db, owner.cookie, 'before');
      const renamed = await call(db, 'PATCH', `/api/workspaces/${made.id}`, {
        cookie: owner.cookie,
        body: { name: 'After the move' },
      });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toEqual({
        id: made.id,
        name: 'After the move',
        slug: made.slug,
        avatarUrl: null,
      });
      const me = (await (await call(db, 'GET', '/api/me', { cookie: owner.cookie })).json()) as {
        memberships: { workspace: { id: string; name: string; slug: string } }[];
      };
      expect(me.memberships.find((m) => m.workspace.id === made.id)?.workspace).toMatchObject({
        name: 'After the move',
        slug: made.slug,
      });
      expect(await trail(db, made.id)).toEqual([
        {
          action: 'workspace.renamed',
          actor_user_id: owner.userId,
          target_type: 'workspace',
          target_id: made.id,
          metadata: { from: 'before', to: 'After the move' },
        },
      ]);
    });
  });

  test('a rename touches this workspace only: another one, its owner’s included, keeps its name', async () => {
    await withRollback(async (db) => {
      const owner = await signedIn(db, 'rn-only');
      const mine = await aWorkspace(db, owner.cookie, 'mine');
      const other = await aWorkspace(db, owner.cookie, 'other');
      const stranger = await signedIn(db, 'rn-stranger');
      const theirs = await aWorkspace(db, stranger.cookie, 'theirs');
      expect(
        (
          await call(db, 'PATCH', `/api/workspaces/${mine.id}`, {
            cookie: owner.cookie,
            body: { name: 'renamed' },
          })
        ).status,
      ).toBe(200);
      const names = await db
        .selectFrom('workspaces')
        .select(['id', 'name'])
        .where('id', 'in', [mine.id, other.id, theirs.id])
        .execute();
      expect(Object.fromEntries(names.map((w) => [w.id, w.name]))).toEqual({
        [mine.id]: 'renamed',
        [other.id]: 'other',
        [theirs.id]: 'theirs',
      });
    });
  });

  test('a name of spaces, or of nothing a person can see, is refused before anything is written', async () => {
    await withRollback(async (db) => {
      const owner = await signedIn(db, 'rn-blank');
      const made = await aWorkspace(db, owner.cookie, 'kept');
      for (const name of ['   ', '\u200B', ' \u200B ']) {
        const refused = await call(db, 'PATCH', `/api/workspaces/${made.id}`, {
          cookie: owner.cookie,
          body: { name },
        });
        expect(refused.status).toBe(400);
      }
      expect(await trail(db, made.id)).toEqual([]);
    });
  });

  test('the same name again changes nothing and records nothing', async () => {
    await withRollback(async (db) => {
      const owner = await signedIn(db, 'rn-same');
      const made = await aWorkspace(db, owner.cookie, 'same');
      const again = await call(db, 'PATCH', `/api/workspaces/${made.id}`, {
        cookie: owner.cookie,
        body: { name: 'same' },
      });
      expect(again.status).toBe(200);
      expect(await trail(db, made.id)).toEqual([]);
    });
  });

  test('an admin demoted after the request began is refused: the role is read where the rename is written (#527)', async () => {
    await withRollback(async (db) => {
      const owner = await signedIn(db, 'rn-race-owner');
      const admin = await signedIn(db, 'rn-race-admin');
      const made = await aWorkspace(db, owner.cookie, 'race');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: made.id, user_id: admin.userId, role: 'admin', joined_at: NOW })
        .execute();
      // The guard's answer, as the request had it before the demotion committed.
      const context = await requireWorkspaceMembership(db, admin.userId, made.id);
      expect(context.role).toBe('admin');
      await db
        .updateTable('workspace_members')
        .set({ role: 'member' })
        .where('workspace_id', '=', made.id)
        .where('user_id', '=', admin.userId)
        .execute();
      let refused = '';
      await renameWorkspace(db, clock, context, 'taken over').catch((error: unknown) => {
        refused = error instanceof AppError ? error.body.code : String(error);
      });
      expect(refused).toBe('FORBIDDEN');
      const kept = await db
        .selectFrom('workspaces')
        .select('name')
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(kept.name).toBe('race');
    });
  });

  test('a member is refused for what they are; a name empty, too long, or beside a slug is 400', async () => {
    await withRollback(async (db) => {
      const owner = await signedIn(db, 'rn-own');
      const member = await signedIn(db, 'rn-mem');
      const made = await aWorkspace(db, owner.cookie, 'kept');
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: made.id, user_id: member.userId, role: 'member', joined_at: NOW })
        .execute();
      const as = async (cookie: string, body: unknown): Promise<string> => {
        const response = await call(db, 'PATCH', `/api/workspaces/${made.id}`, { cookie, body });
        const parsed: unknown = await response.json();
        return Value.Check(ErrorResponse, parsed)
          ? `${String(response.status)} ${parsed.error.code}`
          : String(response.status);
      };
      expect(await as(member.cookie, { name: 'taken over' })).toBe('403 FORBIDDEN');
      expect(await as(owner.cookie, { name: '' })).toBe('400 VALIDATION_FAILED');
      expect(await as(owner.cookie, { name: 'x'.repeat(65) })).toBe('400 VALIDATION_FAILED');
      expect(await as(owner.cookie, { name: 'new', slug: 'moved' })).toBe('400 VALIDATION_FAILED');
      const workspace = await db
        .selectFrom('workspaces')
        .select(['name', 'slug'])
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(workspace).toEqual({ name: 'kept', slug: made.slug });
    });
  });
});
