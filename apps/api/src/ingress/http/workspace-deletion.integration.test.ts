/**
 * Deleting a workspace, over HTTP (D-242): an owner asks, typing its name; it is gone at once for everybody
 * but stays its owners' to take back for the grace period; asked twice is asked once, taken back twice the
 * same; and once the erasure has begun nobody can. Who may is also `permissions.ts`'s, which workspace
 * `cross-tenant.ts`'s; the erasure itself is `workspace-purge.integration.test.ts`'s.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { WORKSPACE_DELETION_GRACE_DAYS, WORKSPACE_NAME_MAX, type MeResponse } from '@purlay/types';
import { DAY_MS, fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const PURGE_AT = new Date(NOW.getTime() + WORKSPACE_DELETION_GRACE_DAYS * DAY_MS).toISOString();
/** A name with letters a Turkish keyboard types, so the comparison is shown to be of the name itself. */
const NAME = 'Çağrı Ekibi — İşler';

interface World {
  readonly db: Executor;
  readonly owner: SignedInUser;
  /** A second owner: anybody who owns it may take a deletion back, not only the one who asked. */
  readonly coOwner: SignedInUser;
  readonly admin: SignedInUser;
  readonly member: SignedInUser;
  /** The owner of a workspace of their own, and in nobody else's. */
  readonly stranger: SignedInUser;
  readonly workspaceId: string;
  readonly otherWorkspaceId: string;
}

const call = async (
  db: Executor,
  method: string,
  path: string,
  as: SignedInUser,
  body?: unknown,
): Promise<{ status: number; json: unknown }> => {
  const response = await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        cookie: as.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  const text = await response.text();
  return { status: response.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
};

const aWorld = async (db: Executor): Promise<World> => {
  const [owner, coOwner, admin, member, stranger] = await Promise.all(
    ['wd-owner', 'wd-coowner', 'wd-admin', 'wd-member', 'wd-stranger'].map(
      async (name) => await aSignedInUser(db, clock, name),
    ),
  );
  if (
    owner === undefined ||
    coOwner === undefined ||
    admin === undefined ||
    member === undefined ||
    stranger === undefined
  ) {
    throw new Error('nobody to test with');
  }
  const made = await call(db, 'POST', '/api/workspaces', owner, {
    name: NAME,
    slug: aUniqueSlug('wd'),
  });
  const workspaceId = (made.json as { id: string }).id;
  for (const [person, role] of [
    [coOwner, 'owner'],
    [admin, 'admin'],
    [member, 'member'],
  ] as const) {
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: person.userId, role, joined_at: NOW })
      .execute();
  }
  const other = await call(db, 'POST', '/api/workspaces', stranger, {
    name: NAME,
    slug: aUniqueSlug('wd-other'),
  });
  return {
    db,
    owner,
    coOwner,
    admin,
    member,
    stranger,
    workspaceId,
    otherWorkspaceId: (other.json as { id: string }).id,
  };
};

const ask = async (
  world: World,
  as: SignedInUser,
  confirm: unknown = NAME,
  workspaceId = world.workspaceId,
): Promise<{ status: number; json: unknown }> =>
  await call(world.db, 'POST', `/api/workspaces/${workspaceId}/deletion`, as, { confirm });

const takeBack = async (
  world: World,
  as: SignedInUser,
  workspaceId = world.workspaceId,
): Promise<{ status: number; json: unknown }> =>
  await call(world.db, 'DELETE', `/api/workspaces/${workspaceId}/deletion`, as);

const me = async (world: World, as: SignedInUser): Promise<MeResponse> => {
  const answer = await call(world.db, 'GET', '/api/me', as);
  expect(answer.status).toBe(200);
  return answer.json as MeResponse;
};

/** The deletion's lines, as a sorted list: at the test's one instant their ids do not order them. */
const trail = async (world: World): Promise<string[]> =>
  (
    await world.db
      .selectFrom('audit_log')
      .select('action')
      .where('workspace_id', '=', world.workspaceId)
      .where('action', 'in', ['workspace.deletion_requested', 'workspace.deletion_cancelled'])
      .execute()
  )
    .map((row) => row.action)
    .sort();

const code = (answer: { json: unknown }): unknown =>
  (answer.json as { error?: { code?: unknown } }).error?.code;

describe('integration: an owner asks for the workspace to be deleted', () => {
  test('gone at once for everybody, listed for its owners to take back, on the trail with when it goes', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const answer = await ask(world, world.owner);
      expect(answer.status).toBe(200);
      expect(answer.json).toMatchObject({
        workspace: { id: world.workspaceId, name: NAME },
        purgeAt: PURGE_AT,
      });
      for (const person of [world.owner, world.coOwner, world.admin, world.member]) {
        // Nobody reaches it, not even who asked; their session is untouched — they may have others.
        expect(code(await call(db, 'GET', `/api/workspaces/${world.workspaceId}`, person))).toBe(
          'WORKSPACE_NOT_FOUND',
        );
        const mine = await me(world, person);
        expect(mine.memberships.map((m) => m.workspace.id)).not.toContain(world.workspaceId);
        const owns = person === world.owner || person === world.coOwner;
        expect(mine.scheduledDeletions).toEqual(
          owns
            ? [
                {
                  workspace: expect.objectContaining({ id: world.workspaceId }) as never,
                  purgeAt: PURGE_AT,
                },
              ]
            : [],
        );
      }
      expect(await trail(world)).toEqual(['workspace.deletion_requested']);
      const { metadata } = await db
        .selectFrom('audit_log')
        .select('metadata')
        .where('workspace_id', '=', world.workspaceId)
        .where('action', '=', 'workspace.deletion_requested')
        .executeTakeFirstOrThrow();
      expect(metadata).toEqual({ purgeAt: PURGE_AT });
      // The other workspace, of the same name, is untouched.
      expect(
        (await call(db, 'GET', `/api/workspaces/${world.otherWorkspaceId}`, world.stranger)).status,
      ).toBe(200);
    });
  });

  test('only an owner: an admin and a member are refused for what they are, a stranger is not told it exists', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const person of [world.admin, world.member]) {
        const refused = await ask(world, person);
        expect(refused.status).toBe(403);
        expect(code(refused)).toBe('FORBIDDEN');
      }
      const crossing = await ask(world, world.stranger);
      expect(crossing.status).toBe(404);
      expect(code(crossing)).toBe('WORKSPACE_NOT_FOUND');
      // And an owner of this one asking for another's, by its id.
      const theirs = await ask(world, world.owner, NAME, world.otherWorkspaceId);
      expect(code(theirs)).toBe('WORKSPACE_NOT_FOUND');
      expect(await trail(world)).toEqual([]);
      expect(
        (await call(db, 'GET', `/api/workspaces/${world.workspaceId}`, world.member)).status,
      ).toBe(200);
      expect(
        (await call(db, 'GET', `/api/workspaces/${world.otherWorkspaceId}`, world.stranger)).status,
      ).toBe(200);
    });
  });

  test('its name, exactly: another, another case, cut short, empty, too long or not a string is refused and changes nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const confirm of [
        'Another',
        NAME.toLocaleLowerCase('tr'),
        NAME.slice(0, -1),
        ` ${NAME}`,
        '',
        'x'.repeat(WORKSPACE_NAME_MAX + 1),
        42,
        null,
      ]) {
        const refused = await ask(world, world.owner, confirm);
        expect(refused.status).toBe(400);
        expect(code(refused)).toBe('VALIDATION_FAILED');
      }
      const missing = await call(
        db,
        'POST',
        `/api/workspaces/${world.workspaceId}/deletion`,
        world.owner,
        {},
      );
      expect(missing.status).toBe(400);
      expect(await trail(world)).toEqual([]);
      expect((await me(world, world.owner)).scheduledDeletions).toEqual([]);
      // The same name decomposed, as some keyboards send it, is the same name.
      expect((await ask(world, world.owner, NAME.normalize('NFD'))).status).toBe(200);
    });
  });

  test('asked twice is asked once: the same answer, one line on the trail', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const first = await ask(world, world.owner);
      const again = await ask(world, world.coOwner);
      expect(again).toEqual(first);
      expect(await trail(world)).toEqual(['workspace.deletion_requested']);
      // Still only an owner's to ask, and still the name.
      expect((await ask(world, world.member)).status).toBe(403);
      expect((await ask(world, world.owner, 'Another')).status).toBe(400);
    });
  });
});

describe('integration: an owner takes the deletion back', () => {
  test('any owner, not only who asked: everybody has it back as it was, and it is on the trail', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await ask(world, world.owner);
      expect(await takeBack(world, world.coOwner)).toEqual({ status: 204, json: null });
      for (const person of [world.owner, world.admin, world.member]) {
        expect((await call(db, 'GET', `/api/workspaces/${world.workspaceId}`, person)).status).toBe(
          200,
        );
        expect((await me(world, person)).scheduledDeletions).toEqual([]);
      }
      expect(await trail(world)).toEqual([
        'workspace.deletion_cancelled',
        'workspace.deletion_requested',
      ]);
      // Taken back twice is taken back once; and asked again, it is asked anew.
      expect((await takeBack(world, world.owner)).status).toBe(204);
      expect(await trail(world)).toHaveLength(2);
      expect((await ask(world, world.owner)).status).toBe(200);
      expect(await trail(world)).toHaveLength(3);
    });
  });

  test('only an owner: an admin and a member are refused, a stranger is not told, and it stays asked for', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await ask(world, world.owner);
      for (const person of [world.admin, world.member]) {
        const refused = await takeBack(world, person);
        expect(refused.status).toBe(403);
        expect(code(refused)).toBe('FORBIDDEN');
      }
      expect(code(await takeBack(world, world.stranger))).toBe('WORKSPACE_NOT_FOUND');
      expect(code(await takeBack(world, world.owner, world.otherWorkspaceId))).toBe(
        'WORKSPACE_NOT_FOUND',
      );
      expect((await me(world, world.owner)).scheduledDeletions).toHaveLength(1);
      expect(await trail(world)).toEqual(['workspace.deletion_requested']);
    });
  });

  test('an owner demoted since is refused under the lock, whatever their membership said before', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await ask(world, world.owner);
      await db
        .updateTable('workspace_members')
        .set({ role: 'admin' })
        .where('workspace_id', '=', world.workspaceId)
        .where('user_id', '=', world.coOwner.userId)
        .execute();
      expect((await takeBack(world, world.coOwner)).status).toBe(403);
      expect((await me(world, world.coOwner)).scheduledDeletions).toEqual([]);
    });
  });

  test('once the erasure has begun it cannot be taken back, nor asked for again; once done, nobody is told it existed', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await ask(world, world.owner);
      await db
        .updateTable('workspaces')
        .set({ purge_started_at: NOW })
        .where('id', '=', world.workspaceId)
        .execute();
      const late = await takeBack(world, world.owner);
      expect(late.status).toBe(409);
      expect(code(late)).toBe('WORKSPACE_DELETION_STARTED');
      expect(code(await ask(world, world.owner))).toBe('WORKSPACE_DELETION_STARTED');
      // No longer offered as something to take back.
      expect((await me(world, world.owner)).scheduledDeletions).toEqual([]);
      await db
        .updateTable('workspaces')
        .set({ purged_at: NOW })
        .where('id', '=', world.workspaceId)
        .execute();
      expect(code(await takeBack(world, world.owner))).toBe('WORKSPACE_NOT_FOUND');
      expect(await trail(world)).toEqual(['workspace.deletion_requested']);
    });
  });
});
