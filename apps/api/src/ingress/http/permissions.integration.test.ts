/**
 * Every role-gated action, as every role (`ARCHITECTURE.md` §7.4, #74). Each request is made in a
 * workspace of its own with an owner, an admin, a member and the person or message acted on, so no
 * case depends on another's outcome. The table is `testing/permissions.ts`; this is its proof.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId, type UserRole } from '@purlay/types';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { PERMISSIONS } from '../../testing/permissions';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

interface World {
  readonly db: Executor;
  readonly people: Readonly<Record<UserRole | 'target', SignedInUser>>;
  readonly workspaceId: string;
  /** A message the target wrote. */
  readonly messageId: string;
}

const call = async (
  world: World,
  method: string,
  path: string,
  as: SignedInUser,
  body?: unknown,
): Promise<Response> =>
  await createApp(testDependencies({ database: world.db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        cookie: as.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const aWorld = async (db: Executor): Promise<World> => {
  const owner = await aSignedInUser(db, clock, 'pm-owner');
  const admin = await aSignedInUser(db, clock, 'pm-admin');
  const member = await aSignedInUser(db, clock, 'pm-member');
  const target = await aSignedInUser(db, clock, 'pm-target');
  const slug = aUniqueSlug('pm');
  const partial: World = {
    db,
    people: { owner, admin, member, target },
    workspaceId: '',
    messageId: '',
  };
  const workspace = await call(partial, 'POST', '/api/workspaces', owner, { name: slug, slug });
  const workspaceId = ((await workspace.json()) as { id: string }).id;
  for (const [person, role] of [
    [admin, 'admin'],
    [member, 'member'],
    [target, 'member'],
  ] as const) {
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspaceId, user_id: person.userId, role, joined_at: NOW })
      .execute();
  }
  const world = { ...partial, workspaceId };
  const channel = await call(world, 'POST', `/api/workspaces/${workspaceId}/channels`, owner, {
    name: 'general',
  });
  const channelId = ((await channel.json()) as { id: string }).id;
  for (const person of [admin, member, target]) {
    await call(world, 'POST', `/api/channels/${channelId}/join`, person);
  }
  const id = messageId(NOW);
  const sent = await call(world, 'POST', `/api/channels/${channelId}/messages`, target, {
    id,
    content: 'written by the target',
  });
  expect(sent.status).toBe(201);
  return { ...world, messageId: id };
};

/** Each case's request, made as one role. */
const ACTIONS: Readonly<Record<string, (world: World, as: SignedInUser) => Promise<Response>>> = {
  'make a member an admin': async (world, as) =>
    await call(
      world,
      'PATCH',
      `/api/workspaces/${world.workspaceId}/members/${world.people.target.userId}`,
      as,
      { role: 'admin' },
    ),
  'make a member an owner (transfer ownership)': async (world, as) =>
    await call(
      world,
      'PATCH',
      `/api/workspaces/${world.workspaceId}/members/${world.people.target.userId}`,
      as,
      { role: 'owner' },
    ),
  'remove a member': async (world, as) =>
    await call(
      world,
      'DELETE',
      `/api/workspaces/${world.workspaceId}/members/${world.people.target.userId}`,
      as,
    ),
  'read the audit trail': async (world, as) =>
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/audit`, as),
  'delete somebody else’s message': async (world, as) =>
    await call(world, 'DELETE', `/api/messages/${world.messageId}`, as),
};

describe('integration: every role-gated action, as every role', () => {
  test('each case in the table has its request here', () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  for (const [name, entry] of Object.entries(PERMISSIONS)) {
    for (const role of ['owner', 'admin', 'member'] as const) {
      const allowed = entry.allowed[role];
      test(`${name}: ${role} is ${allowed ? 'allowed' : 'refused, 403'}`, async () => {
        await withRollback(async (db) => {
          const world = await aWorld(db);
          const act = ACTIONS[name];
          if (act === undefined) throw new Error(`no request for ${name}`);
          const response = await act(world, world.people[role]);
          if (allowed) {
            expect({ status: response.status, ok: response.ok }).toEqual({
              status: response.status,
              ok: true,
            });
          } else {
            expect(response.status).toBe(403);
            expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
          }
        });
      });
    }
  }
});
