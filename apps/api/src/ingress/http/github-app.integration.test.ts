/**
 * The GitHub App over HTTP (D-246 §1–2, `API.md` §7): an owner connects an installation and a person authorizes
 * for themselves, through GitHub's stand-in, which refuses what GitHub refuses; what comes back is believed only
 * as far as GitHub vouches for it; tokens are sealed and never answered; and nothing of it exists on a server
 * without an App.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { GitHubAppRedirect, GitHubAppStatus } from '@purlay/types';
import { fixedClock, type Clock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { aGitHubAppStub, GITHUB_APP_STUB, type GitHubAppStub } from '../../testing/github-app-stub';
import { aGitHubStub } from '../../testing/github-stub';
import { aRoom } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { testDependencies } from '../../testing/doubles';
import { createApp, type HttpApplication } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-11-01T12:00:00.000Z');
const PERSON = { id: 501, login: 'ayse-dev' };
const REPOSITORIES = [{ id: 77, fullName: 'acme/api', private: true }];

interface World {
  readonly app: HttpApplication;
  readonly github: GitHubAppStub;
  readonly workspaceId: string;
  readonly slug: string;
  readonly owner: { readonly userId: string; readonly cookie: string };
  readonly member: { readonly userId: string; readonly cookie: string };
  readonly clock: { now: Date };
  readonly db: Executor;
}

const aWorld = async (
  db: Executor,
  options: { readonly app?: boolean; readonly timeoutMs?: number } = {},
): Promise<World> => {
  const room = await aRoom(db, ['owner', 'member']);
  const time = { now: NOW };
  const clock: Clock = { now: () => time.now };
  const cookieOf = async (name: string): Promise<{ userId: string; cookie: string }> => {
    const userId = room.members[name]?.userId ?? '';
    const { token } = await aSession(db, fixedClock(NOW), userId, 30);
    return { userId, cookie: `${SESSION_COOKIE}=${token}` };
  };
  const github = aGitHubAppStub(PERSON, { now: () => time.now.getTime() });
  github.install(31, 'acme', REPOSITORIES);
  const stub = aGitHubStub({ ...PERSON, name: null, email: 'ayse@example.test' }, {}, undefined, {
    app: github,
  });
  const app = createApp(
    testDependencies({
      database: db,
      clock,
      githubApp: () => (options.app === false ? undefined : GITHUB_APP_STUB),
      githubAppFetch: stub.appFetch,
    }),
  );
  const slug = (
    await db
      .selectFrom('workspaces')
      .select('slug')
      .where('id', '=', room.workspaceId)
      .executeTakeFirstOrThrow()
  ).slug;
  return {
    app,
    github,
    workspaceId: room.workspaceId,
    slug,
    owner: await cookieOf('owner'),
    member: await cookieOf('member'),
    clock: time,
    db,
  };
};

const call = async (
  world: World,
  method: string,
  path: string,
  options: { readonly cookie?: string; readonly body?: unknown } = {},
): Promise<Response> =>
  await world.app.handle(
    new Request(path.startsWith('http') ? path : `https://purlay.test${path}`, {
      method,
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        origin: 'https://purlay.test',
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );

const statusOf = async (world: World, cookie: string): Promise<GitHubAppStatus> => {
  const answer: unknown = await (
    await call(world, 'GET', `/api/workspaces/${world.workspaceId}/github-app`, { cookie })
  ).json();
  if (!Value.Check(GitHubAppStatus, answer)) throw new Error('not a GitHubAppStatus');
  return answer;
};

const redirectOf = async (response: Response): Promise<string> => {
  expect(response.status).toBe(200);
  const answer: unknown = await response.json();
  if (!Value.Check(GitHubAppRedirect, answer)) throw new Error('not a GitHubAppRedirect');
  return answer.url;
};

/** The owner to GitHub's installation screen, Install pressed, and back: where the browser is sent then. */
const install = async (
  world: World,
  who: { readonly cookie: string } = world.owner,
  installationId = 31,
): Promise<string> => {
  const url = await redirectOf(
    await call(world, 'POST', `/api/workspaces/${world.workspaceId}/github-app/installation`, {
      cookie: world.owner.cookie,
    }),
  );
  const back = await call(world, 'GET', world.github.installOnGitHub(url, installationId), {
    cookie: who.cookie,
  });
  expect(back.status).toBe(302);
  return back.headers.get('location') ?? '';
};

describe('integration: a GitHub App installation, connected by an owner (D-246 §1)', () => {
  test('a server without an App offers nothing: the status says so, and every start is absent', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { app: false });
      expect(await statusOf(world, world.member.cookie)).toEqual({
        available: false,
        installation: null,
        authorization: null,
      });
      for (const [method, path, body] of [
        ['POST', `/api/workspaces/${world.workspaceId}/github-app/installation`, undefined],
        ['POST', '/api/github-app/authorization', { returnTo: '/' }],
      ] as const) {
        const refused = await call(world, method, path, { cookie: world.owner.cookie, body });
        expect(refused.status).toBe(404);
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
          'ROUTE_NOT_FOUND',
        );
      }
    });
  });

  test('the owner installs on GitHub and comes back connected, keeping no token of theirs', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(await install(world)).toBe(`/w/${world.slug}/settings/integrations?github=connected`);
      expect(await statusOf(world, world.owner.cookie)).toEqual({
        available: true,
        installation: {
          accountLogin: 'acme',
          accountType: 'Organization',
          suspended: false,
          connectedAt: NOW.toISOString(),
        },
        authorization: null,
      });
      // The code proved who came back; writing as oneself is a separate opt-in (D-246 §2).
      expect(
        await db
          .selectFrom('github_user_authorizations')
          .select('id')
          .where('user_id', '=', world.owner.userId)
          .execute(),
      ).toEqual([]);
      const trail = await db
        .selectFrom('audit_log')
        .select(['action', 'actor_user_id', 'metadata'])
        .where('workspace_id', '=', world.workspaceId)
        .execute();
      expect(trail).toEqual([
        {
          action: 'integration.app_connected',
          actor_user_id: world.owner.userId,
          metadata: { account: 'acme' },
        },
      ]);
    });
  });

  test('a member may not start one, and a stranger is told the workspace is not there', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const member = await call(
        world,
        'POST',
        `/api/workspaces/${world.workspaceId}/github-app/installation`,
        { cookie: world.member.cookie },
      );
      expect(member.status).toBe(403);
      const stranger = await aRoom(db, ['stranger']);
      const { token } = await aSession(
        db,
        fixedClock(NOW),
        stranger.members['stranger']?.userId ?? '',
      );
      const cookie = `${SESSION_COOKIE}=${token}`;
      for (const [method, path] of [
        ['GET', `/api/workspaces/${world.workspaceId}/github-app`],
        ['POST', `/api/workspaces/${world.workspaceId}/github-app/installation`],
        ['DELETE', `/api/workspaces/${world.workspaceId}/github-app/installation`],
      ] as const) {
        const refused = await call(world, method, path, { cookie });
        expect(refused.status).toBe(404);
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
          'WORKSPACE_NOT_FOUND',
        );
      }
    });
  });

  test('what comes back is believed only as far as GitHub vouches for it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      // An installation the person cannot reach on GitHub: the query named it, the code says otherwise.
      world.github.install(32, 'someone-else', [], { reachable: false });
      expect(await install(world, world.owner, 32)).toBe(
        `/w/${world.slug}/settings/integrations?github=not-yours`,
      );
      // Somebody else's browser bringing the owner's trip back connects nothing of theirs.
      expect(await install(world, world.member)).toBe(
        `/w/${world.slug}/settings/integrations?github=not-yours`,
      );
      expect((await statusOf(world, world.owner.cookie)).installation).toBeNull();
      expect(
        await db
          .selectFrom('github_user_authorizations')
          .select('id')
          .where('user_id', '=', world.owner.userId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('a trip comes back once, within ten minutes, and a refusal on GitHub is said', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const url = await redirectOf(
        await call(world, 'POST', `/api/workspaces/${world.workspaceId}/github-app/installation`, {
          cookie: world.owner.cookie,
        }),
      );
      const back = world.github.installOnGitHub(url, 31);
      const first = await call(world, 'GET', back, { cookie: world.owner.cookie });
      expect(first.headers.get('location')).toEndWith('?github=connected');
      const again = await call(world, 'GET', back, { cookie: world.owner.cookie });
      expect(again.headers.get('location')).toBe('/?github=expired');

      const late = await redirectOf(
        await call(world, 'POST', `/api/workspaces/${world.workspaceId}/github-app/installation`, {
          cookie: world.owner.cookie,
        }),
      );
      world.clock.now = new Date(NOW.getTime() + 10 * 60 * 1000 + 1);
      const tooLate = await call(world, 'GET', world.github.installOnGitHub(late, 31), {
        cookie: world.owner.cookie,
      });
      expect(tooLate.headers.get('location')).toBe('/?github=expired');

      const cancelled = await redirectOf(
        await call(world, 'POST', `/api/workspaces/${world.workspaceId}/github-app/installation`, {
          cookie: world.owner.cookie,
        }),
      );
      const state = new URL(cancelled).searchParams.get('state') ?? '';
      const denied = await call(
        world,
        'GET',
        `/api/github-app/callback?error=access_denied&state=${state}`,
        { cookie: world.owner.cookie },
      );
      expect(denied.headers.get('location')).toBe(
        `/w/${world.slug}/settings/integrations?github=refused`,
      );
      for (const query of ['', '?state=nope', `?state=${'0'.repeat(64)}`]) {
        const nothing = await call(world, 'GET', `/api/github-app/callback${query}`, {
          cookie: world.owner.cookie,
        });
        expect([nothing.status, nothing.headers.get('location')]).toEqual([
          302,
          '/?github=expired',
        ]);
      }
    });
  });

  test('GitHub not answering, or limiting, is said as unavailable and keeps nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      world.github.behaviour.limit = { times: 1, retryAfter: 30 };
      expect(await install(world)).toEndWith('?github=unavailable');
      world.github.behaviour.unreachable = true;
      expect(await install(world)).toEndWith('?github=unavailable');
      expect((await statusOf(world, world.owner.cookie)).installation).toBeNull();
    });
  });

  test('the owner lets it go: the trail says so, and again is nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await install(world);
      const path = `/api/workspaces/${world.workspaceId}/github-app/installation`;
      expect((await call(world, 'DELETE', path, { cookie: world.member.cookie })).status).toBe(403);
      expect((await call(world, 'DELETE', path, { cookie: world.owner.cookie })).status).toBe(204);
      expect((await call(world, 'DELETE', path, { cookie: world.owner.cookie })).status).toBe(204);
      expect((await statusOf(world, world.owner.cookie)).installation).toBeNull();
      const actions = await db
        .selectFrom('audit_log')
        .select('action')
        .where('workspace_id', '=', world.workspaceId)
        .execute();
      // The clock stands still in this test, so the trail's order by time is not an order to assert.
      expect(actions.map((row) => row.action).sort()).toEqual([
        'integration.app_connected',
        'integration.app_disconnected',
      ]);
    });
  });
});

describe('integration: a person’s own authorization (D-246 §2)', () => {
  test('authorized with PKCE, brought back where they were, and forgotten when they ask', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const returnTo = `/w/${world.slug}/c/general`;
      const url = await redirectOf(
        await call(world, 'POST', '/api/github-app/authorization', {
          cookie: world.member.cookie,
          body: { returnTo },
        }),
      );
      expect(new URL(url).searchParams.get('code_challenge_method')).toBe('S256');
      const back = await call(world, 'GET', world.github.authorizeOnGitHub(url), {
        cookie: world.member.cookie,
      });
      expect(back.headers.get('location')).toBe(`${returnTo}?github=authorized`);
      expect((await statusOf(world, world.member.cookie)).authorization).toEqual({
        login: PERSON.login,
      });
      const gone = await call(world, 'DELETE', '/api/github-app/authorization', {
        cookie: world.member.cookie,
      });
      expect(gone.status).toBe(204);
      expect((await statusOf(world, world.member.cookie)).authorization).toBeNull();
    });
  });

  test('only a path of this origin is somewhere to come back to', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const returnTo of [
        '//evil.example/x',
        'https://evil.example',
        '/\\evil',
        'relative',
        '',
      ]) {
        const refused = await call(world, 'POST', '/api/github-app/authorization', {
          cookie: world.member.cookie,
          body: { returnTo },
        });
        expect([returnTo, refused.status]).toEqual([returnTo, 400]);
      }
      const signedOut = await call(world, 'POST', '/api/github-app/authorization', {
        body: { returnTo: '/' },
      });
      expect(signedOut.status).toBe(401);
    });
  });

  test('a signed-out browser that brings a trip back is not its person', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const url = await redirectOf(
        await call(world, 'POST', '/api/github-app/authorization', {
          cookie: world.member.cookie,
          body: { returnTo: '/' },
        }),
      );
      const back = await call(world, 'GET', world.github.authorizeOnGitHub(url));
      expect(back.headers.get('location')).toBe('/?github=not-yours');
      expect((await statusOf(world, world.member.cookie)).authorization).toBeNull();
    });
  });
});

describe('integration: the App’s deliveries (D-246 §1)', () => {
  const deliver = async (
    world: World,
    event: string,
    body: unknown,
    options: { readonly deliveryId?: string; readonly signature?: string } = {},
  ): Promise<Response> => {
    const signed = world.github.delivery(event, body, options.deliveryId);
    return await world.app.handle(
      new Request('https://purlay.test/api/webhooks/github-app', {
        method: 'POST',
        headers: {
          ...signed.headers,
          ...(options.signature === undefined ? {} : { 'x-hub-signature-256': options.signature }),
        },
        body: signed.body,
      }),
    );
  };

  test('nothing is believed without the App’s signature, and without an App there is no address', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const forged = await deliver(
        world,
        'ping',
        { zen: 'hi' },
        { signature: `sha256=${'0'.repeat(64)}` },
      );
      expect(forged.status).toBe(401);
      expect(await (await deliver(world, 'ping', { zen: 'hi' })).json()).toEqual({
        outcome: 'pinged',
      });
      const none = await aWorld(db, { app: false });
      expect((await deliver(none, 'ping', { zen: 'hi' })).status).toBe(404);
    });
  });

  test('an installation removed on GitHub is let go everywhere it was connected, once', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await install(world);
      const removal = { action: 'deleted', installation: { id: 31 } };
      const first = await deliver(world, 'installation', removal, { deliveryId: 'd-1' });
      expect(await first.json()).toEqual({ outcome: 'applied' });
      expect((await statusOf(world, world.owner.cookie)).installation).toBeNull();
      const trail = await db
        .selectFrom('audit_log')
        .select(['action', 'actor_user_id'])
        .where('workspace_id', '=', world.workspaceId)
        .where('action', '=', 'integration.app_disconnected')
        .execute();
      expect(trail).toEqual([{ action: 'integration.app_disconnected', actor_user_id: null }]);
      // The same delivery again, and the same body under an id made up: nothing more.
      for (const deliveryId of ['d-1', 'd-made-up']) {
        expect(
          await (await deliver(world, 'installation', removal, { deliveryId })).json(),
        ).toEqual({
          outcome: 'duplicate',
        });
      }
    });
  });

  test('removed on GitHub, it goes from every workspace of one organisation that connected it', async () => {
    await withRollback(async (db) => {
      const first = await aWorld(db);
      const second = await aWorld(db);
      // Two workspaces, one organisation: GitHub's installation id is not unique to either.
      await install(first);
      second.github.install(31, 'acme', REPOSITORIES);
      await install(second);
      const removed = await deliver(first, 'installation', {
        action: 'deleted',
        installation: { id: 31 },
      });
      expect(await removed.json()).toEqual({ outcome: 'applied' });
      expect((await statusOf(first, first.owner.cookie)).installation).toBeNull();
      expect((await statusOf(second, second.owner.cookie)).installation).toBeNull();
      // Each workspace's own trail says GitHub let it go.
      for (const world of [first, second]) {
        const trail = await db
          .selectFrom('audit_log')
          .select('action')
          .where('workspace_id', '=', world.workspaceId)
          .where('action', '=', 'integration.app_disconnected')
          .execute();
        expect(trail).toHaveLength(1);
      }
    });
  });

  test('a suspension is kept and said; lifted, it is gone', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await install(world);
      await deliver(world, 'installation', { action: 'suspend', installation: { id: 31 } });
      expect((await statusOf(world, world.owner.cookie)).installation?.suspended).toBe(true);
      await deliver(world, 'installation', { action: 'unsuspend', installation: { id: 31 } });
      expect((await statusOf(world, world.owner.cookie)).installation?.suspended).toBe(false);
      expect(
        await (
          await deliver(world, 'installation', { action: 'created', installation: { id: 31 } })
        ).json(),
      ).toEqual({ outcome: 'ignored' });
    });
  });

  test('a person who revoked the App on GitHub is forgotten here', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await install(world);
      const url = await redirectOf(
        await call(world, 'POST', '/api/github-app/authorization', {
          cookie: world.owner.cookie,
          body: { returnTo: '/' },
        }),
      );
      await call(world, 'GET', world.github.authorizeOnGitHub(url), { cookie: world.owner.cookie });
      expect((await statusOf(world, world.owner.cookie)).authorization).not.toBeNull();
      const revoked = await deliver(world, 'github_app_authorization', {
        action: 'revoked',
        sender: { id: PERSON.id, login: PERSON.login },
      });
      expect(await revoked.json()).toEqual({ outcome: 'applied' });
      expect((await statusOf(world, world.owner.cookie)).authorization).toBeNull();
      // The installation is the workspace's, not the person's: it stays.
      expect((await statusOf(world, world.owner.cookie)).installation).not.toBeNull();
    });
  });

  test('a body that is not the event it names, or no event at all, is refused and recorded as nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect((await deliver(world, 'installation', { action: 'deleted' })).status).toBe(400);
      expect((await deliver(world, 'github_app_authorization', { action: 'revoked' })).status).toBe(
        400,
      );
      expect(
        await db
          .selectFrom('github_app_deliveries')
          .select('delivery_id')
          .where('received_at', '>=', NOW)
          .execute(),
      ).toEqual([]);
      expect(await (await deliver(world, 'issues', { action: 'opened' })).json()).toEqual({
        outcome: 'ignored',
      });
    });
  });
});
