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
  /** Public, and everybody is in it. */
  readonly channelId: string;
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
    channelId: '',
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
  return { ...world, channelId, messageId: id };
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
  'rename the workspace': async (world, as) =>
    await call(world, 'PATCH', `/api/workspaces/${world.workspaceId}`, as, {
      name: `renamed by ${as.username}`,
    }),
  'read the audit trail': async (world, as) =>
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/audit`, as),
  'see whether the GitHub token is set': async (world, as) =>
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/integrations/github`, as),
  'set the GitHub token': async (world, as) =>
    await call(world, 'PUT', `/api/workspaces/${world.workspaceId}/integrations/github`, as, {
      token: 'ghp_permission',
    }),
  'remove the GitHub token': async (world, as) => {
    // Set by the owner first, so there is one to remove whoever tries.
    await call(
      world,
      'PUT',
      `/api/workspaces/${world.workspaceId}/integrations/github`,
      world.people.owner,
      {
        token: 'ghp_permission',
      },
    );
    return await call(
      world,
      'DELETE',
      `/api/workspaces/${world.workspaceId}/integrations/github`,
      as,
    );
  },
  'make an invitation link': async (world, as) =>
    await call(world, 'POST', `/api/workspaces/${world.workspaceId}/invitations`, as),
  'list the invitation links': async (world, as) =>
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/invitations`, as),
  'revoke an invitation link': async (world, as) => {
    // Made by the owner, so each role is tried on a link that exists and still opens.
    const made = await call(
      world,
      'POST',
      `/api/workspaces/${world.workspaceId}/invitations`,
      world.people.owner,
    );
    const { invitation } = (await made.json()) as { invitation: { id: string } };
    return await call(
      world,
      'DELETE',
      `/api/workspaces/${world.workspaceId}/invitations/${invitation.id}`,
      as,
    );
  },
  'archive a channel': async (world, as) =>
    await call(world, 'DELETE', `/api/channels/${world.channelId}`, as),
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

/**
 * D-26, I-9 as a mechanism (#69): every role-gated action that changes something writes exactly one
 * row of the workspace's trail — taken from the same table, so an administrative endpoint added
 * there is held to it without anybody remembering. A read writes none.
 */
describe('integration: every administrative write is on the trail, once', () => {
  const rows = async (db: Executor, workspaceId: string): Promise<number> =>
    (
      await db
        .selectFrom('audit_log')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .execute()
    ).length;

  /** Rows the set-up of a case writes before its action (a link made, a token set), not its own. */
  const SET_UP_ROWS: Readonly<Record<string, number>> = {
    'revoke an invitation link': 1,
    'remove the GitHub token': 1,
  };

  for (const [name, entry] of Object.entries(PERMISSIONS)) {
    const reads = entry.endpoint.startsWith('GET ');
    test(`${name}: ${reads ? 'no row' : 'one row'}`, async () => {
      await withRollback(async (db) => {
        const world = await aWorld(db);
        const act = ACTIONS[name];
        if (act === undefined) throw new Error(`no request for ${name}`);
        const before = await rows(db, world.workspaceId);
        const response = await act(world, world.people.owner);
        expect(response.ok).toBe(true);
        // What an action does on the way (making a link to revoke it) is counted by the action's own case.
        const setUp = SET_UP_ROWS[name] ?? 0;
        expect((await rows(db, world.workspaceId)) - before - setUp).toBe(reads ? 0 : 1);
      });
    });
  }
});

/**
 * Who did it, and from which session (D-116, #397): a row written by a request names the session that
 * made it, through which the sign-in's address and agent are known for as long as the session lives.
 */
describe('integration: the trail names the session that acted', () => {
  test('an administrative write over HTTP records the caller’s session', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const act = ACTIONS['make an invitation link'];
      if (act === undefined) throw new Error('no request');
      expect((await act(world, world.people.admin)).ok).toBe(true);
      const [row] = await db
        .selectFrom('audit_log')
        .select(['action', 'session_id'])
        .where('workspace_id', '=', world.workspaceId)
        .where('action', '=', 'invitation.created')
        .execute();
      expect(row).toEqual({
        action: 'invitation.created',
        session_id: world.people.admin.sessionId,
      });
    });
  });
});
