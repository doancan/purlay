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
import { workspacePrefix } from '../../platform/storage';
import { NOW, testDependencies } from '../../testing/doubles';
import { GITHUB_APP_STUB } from '../../testing/github-app-stub';
import { PERMISSIONS } from '../../testing/permissions';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { aMemoryStore } from '../../testing/storage';

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
  await createApp(
    testDependencies({ database: world.db, clock, githubApp: () => GITHUB_APP_STUB }),
  ).handle(
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
    name: 'ops',
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
  'read how long the history is kept': async (world, as) =>
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/retention`, as),
  'set how long the history is kept': async (world, as) =>
    await call(world, 'PUT', `/api/workspaces/${world.workspaceId}/retention`, as, {
      retentionDays: 90,
    }),
  'read how long a channel keeps its history': async (world, as) =>
    await call(world, 'GET', `/api/channels/${world.channelId}/retention`, as),
  'let a channel keep its history longer': async (world, as) =>
    await call(world, 'PUT', `/api/channels/${world.channelId}/retention`, as, {
      keepsAtLeast: 'forever',
    }),
  'ask for the workspace to be deleted': async (world, as) => {
    const { name } = await world.db
      .selectFrom('workspaces')
      .select('name')
      .where('id', '=', world.workspaceId)
      .executeTakeFirstOrThrow();
    return await call(world, 'POST', `/api/workspaces/${world.workspaceId}/deletion`, as, {
      confirm: name,
    });
  },
  'take back the workspace’s deletion': async (world, as) => {
    // Asked for by the owner first, so each role is tried on a deletion there is to take back.
    const { name } = await world.db
      .selectFrom('workspaces')
      .select('name')
      .where('id', '=', world.workspaceId)
      .executeTakeFirstOrThrow();
    const asked = await call(
      world,
      'POST',
      `/api/workspaces/${world.workspaceId}/deletion`,
      world.people.owner,
      { confirm: name },
    );
    expect(asked.status).toBe(200);
    return await call(world, 'DELETE', `/api/workspaces/${world.workspaceId}/deletion`, as);
  },
  'export the workspace': async (world, as) =>
    await call(world, 'POST', `/api/workspaces/${world.workspaceId}/exports`, as),
  'read the workspace’s exports': async (world, as) =>
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/exports`, as),
  'download an export': async (world, as) => {
    // A ready export, its archive in a store of the test's own.
    const store = aMemoryStore();
    const id = messageId(NOW);
    const key = `${workspacePrefix(world.workspaceId)}exports/${id}.tar`;
    await store.put(key, new Uint8Array(1024), 'application/x-tar');
    await world.db
      .insertInto('workspace_exports')
      .values({
        id,
        workspace_id: world.workspaceId,
        requested_by: world.people.owner.userId,
        status: 'ready',
        storage_key: key,
        size_bytes: '1024',
        created_at: NOW,
        expires_at: new Date(NOW.getTime() + 60_000),
      })
      .execute();
    return await createApp(testDependencies({ database: world.db, clock, storage: store })).handle(
      new Request(
        `https://purlay.test/api/workspaces/${world.workspaceId}/exports/${id}/download`,
        { headers: { cookie: as.cookie } },
      ),
    );
  },
  'read the audit trail': async (world, as) =>
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/audit`, as),
  'download the audit trail': async (world, as) =>
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/audit/export?format=csv`, as),
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
  'start connecting a GitHub App installation': async (world, as) =>
    await call(world, 'POST', `/api/workspaces/${world.workspaceId}/github-app/installation`, as),
  'disconnect the GitHub App installation': async (world, as) => {
    // Connected by the owner first (as the callback would have), so there is one to remove whoever tries.
    await world.db
      .insertInto('github_app_installations')
      .values({
        id: crypto.randomUUID(),
        workspace_id: world.workspaceId,
        installation_id: '31',
        account_login: 'acme',
        account_type: 'Organization',
        connected_by: world.people.owner.userId,
        connected_at: NOW,
      })
      .execute();
    return await call(
      world,
      'DELETE',
      `/api/workspaces/${world.workspaceId}/github-app/installation`,
      as,
    );
  },
  'list a channel’s repository feeds': async (world, as) =>
    await call(world, 'GET', `/api/channels/${world.channelId}/github-feeds`, as),
  'connect a repository to a channel': async (world, as) =>
    await call(world, 'POST', `/api/channels/${world.channelId}/github-feeds`, as, {
      repository: 'acme/permission',
      events: ['push'],
    }),
  'disconnect a repository from a channel': async (world, as) => {
    // Connected by the owner first, so there is one to disconnect whoever tries.
    const made = await call(
      world,
      'POST',
      `/api/channels/${world.channelId}/github-feeds`,
      world.people.owner,
      { repository: 'acme/permission', events: ['push'] },
    );
    const { feed } = (await made.json()) as { feed: { id: string } };
    return await call(
      world,
      'DELETE',
      `/api/channels/${world.channelId}/github-feeds/${feed.id}`,
      as,
    );
  },
  'list a channel’s incoming webhooks': async (world, as) =>
    await call(world, 'GET', `/api/channels/${world.channelId}/incoming-webhooks`, as),
  'make an incoming webhook': async (world, as) =>
    await call(world, 'POST', `/api/channels/${world.channelId}/incoming-webhooks`, as, {
      name: 'CI',
    }),
  'revoke an incoming webhook': async (world, as) => {
    // Made by the owner first, so there is one to revoke whoever tries.
    const made = await call(
      world,
      'POST',
      `/api/channels/${world.channelId}/incoming-webhooks`,
      world.people.owner,
      { name: 'CI' },
    );
    const { webhook } = (await made.json()) as { webhook: { id: string } };
    return await call(
      world,
      'DELETE',
      `/api/channels/${world.channelId}/incoming-webhooks/${webhook.id}`,
      as,
    );
  },
  'take somebody out of a public channel': async (world, as) =>
    await call(
      world,
      'DELETE',
      `/api/channels/${world.channelId}/members/${world.people.target.userId}`,
      as,
    ),
  'read the workspace’s storage and quota': async (world, as) =>
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/storage`, as),
  'let only owners and admins post in a channel': async (world, as) =>
    await call(world, 'PATCH', `/api/channels/${world.channelId}`, as, { onlyAdminsPost: true }),
  'archive a channel': async (world, as) =>
    await call(world, 'DELETE', `/api/channels/${world.channelId}`, as),
  'see the archived channels': async (world, as) =>
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/archived-channels`, as),
  // Archived by the database, not the route: the set-up writes no row of the trail (D-232).
  'bring an archived channel back': async (world, as) => {
    await world.db
      .updateTable('channels')
      .set({ deleted_at: NOW })
      .where('id', '=', world.channelId)
      .execute();
    return await call(world, 'POST', `/api/channels/${world.channelId}/restore`, as);
  },
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
 * there is held to it without anybody remembering. A read writes none — but a download of the trail
 * itself, which is on it as `audit.exported` (D-222).
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
    'disconnect a repository from a channel': 1,
    'take back the workspace’s deletion': 1,
    'revoke an incoming webhook': 1,
  };

  /** Reads that are themselves administrative acts: taking the trail away is on it (D-222). */
  const RECORDED_READS: ReadonlySet<string> = new Set(['download the audit trail']);
  /** A write that changes nothing yet: GitHub's screen is where the change is made, and the callback records it. */
  const CHANGES_NOTHING: ReadonlySet<string> = new Set([
    'start connecting a GitHub App installation',
  ]);

  for (const [name, entry] of Object.entries(PERMISSIONS)) {
    const reads =
      (entry.endpoint.startsWith('GET ') && !RECORDED_READS.has(name)) || CHANGES_NOTHING.has(name);
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
