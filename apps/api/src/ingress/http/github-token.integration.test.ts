/**
 * The workspace's GitHub token over HTTP (D-23, amended; #884): GitHub is asked whether it accepts a
 * token before it is kept — a refused token is `400` on the field and saves nothing, a GitHub that
 * cannot say is `503 GITHUB_UNAVAILABLE` and saves nothing — the scopes it came with are recorded so a
 * classic `repo` token is warned about, a member's attempt costs GitHub no request, and a token GitHub
 * later refuses is shown to admins until it is replaced. GitHub is the API stand-in (`aGitHubApiStub`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { GitHubIntegration } from '@purlay/types';
import { githubApi } from '../../modules/integrations/unfurl';
import { aMovableClock, testDependencies } from '../../testing/doubles';
import { aGitHubApiStub, type GitHubApiStub } from '../../testing/github-stub';
import { aRoom } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { SESSION_COOKIE } from '../../platform/cookies';
import { createApp } from './app';

let stub: GitHubApiStub;
beforeAll(() => {
  stub = aGitHubApiStub();
});
afterAll(async () => {
  await stub.stop();
  await closeIntegrationDatabase();
});

const clock = aMovableClock();

interface World {
  readonly workspaceId: string;
  readonly as: (name: 'alice' | 'bob') => Call;
}
type Call = (method: string, path: string, body?: unknown) => Promise<Response>;

const aWorld = async (db: Executor, api = githubApi(stub.url)): Promise<World> => {
  stub.answer(null);
  stub.requests.length = 0;
  const room = await aRoom(db, ['alice', 'bob']);
  const app = createApp(testDependencies({ database: db, clock, githubApi: api }));
  const cookies = new Map<string, string>();
  for (const name of ['alice', 'bob']) {
    const { token } = await aSession(db, clock, room.members[name]?.userId ?? '', 30);
    cookies.set(name, `${SESSION_COOKIE}=${token}`);
  }
  return {
    workspaceId: room.workspaceId,
    as: (name) => async (method, path, body) =>
      await app.handle(
        new Request(`https://purlay.test${path}`, {
          method,
          headers: {
            cookie: cookies.get(name) ?? '',
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
  };
};

const integration = (world: World): string =>
  `/api/workspaces/${world.workspaceId}/integrations/github`;

const read = async (world: World): Promise<GitHubIntegration> => {
  const response = await world.as('alice')('GET', integration(world));
  const body: unknown = await response.json();
  if (!Value.Check(GitHubIntegration, body)) throw new Error('not a GitHubIntegration');
  return body;
};

describe('integration: saving the workspace’s GitHub token', () => {
  test('a token GitHub accepts is saved; a fine-grained one carries no scopes, so no warning', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      stub.accept('github_pat_fine');
      const saved = await world.as('alice')('PUT', integration(world), {
        token: 'github_pat_fine',
      });
      expect(saved.status).toBe(204);
      expect(await read(world)).toMatchObject({
        configured: true,
        invalidSince: null,
        broadScopes: false,
      });
      // GitHub was asked with the token, at /rate_limit (which costs no quota), and nothing else.
      expect(stub.requests).toEqual([{ path: '/rate_limit', token: 'github_pat_fine' }]);
    });
  });

  test('a classic token with repo is saved and warned about; replaced by a narrower one, the warning goes', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      stub.accept('ghp_classic', 'repo, read:org');
      expect(
        (await world.as('alice')('PUT', integration(world), { token: 'ghp_classic' })).status,
      ).toBe(204);
      expect(await read(world)).toMatchObject({ configured: true, broadScopes: true });
      stub.accept('github_pat_narrow');
      expect(
        (await world.as('alice')('PUT', integration(world), { token: 'github_pat_narrow' })).status,
      ).toBe(204);
      expect(await read(world)).toMatchObject({ configured: true, broadScopes: false });
      // Removed, nothing is left to warn of.
      await world.as('alice')('DELETE', integration(world));
      expect(await read(world)).toMatchObject({ configured: false, broadScopes: false });
    });
  });

  test('a token GitHub refuses is 400 on the field, saves nothing, and leaves the token that was there', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      stub.accept('ghp_kept');
      await world.as('alice')('PUT', integration(world), { token: 'ghp_kept' });
      const before = await read(world);

      const refused = await world.as('alice')('PUT', integration(world), { token: 'ghp_unknown' });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          details: { fields: { token: expect.any(String) as string } },
        },
      });
      expect(await read(world)).toEqual(before);
      // The token is never echoed in the refusal.
      const again = await world.as('alice')('PUT', integration(world), { token: 'ghp_unknown' });
      expect(JSON.stringify(await again.json())).not.toContain('ghp_unknown');
    });
  });

  test('a GitHub that cannot say — failing, rate limiting, unreachable — is 503 and saves nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      stub.accept('ghp_any');
      const answers: Record<string, () => Response> = {
        'a failing GitHub': () => new Response('{}', { status: 503 }),
        'a rate limit': () => Response.json({}, { status: 429, headers: { 'retry-after': '30' } }),
        'a 403 naming no time': () => new Response('{}', { status: 403 }),
      };
      for (const [what, answer] of Object.entries(answers)) {
        stub.answer(answer);
        const response = await world.as('alice')('PUT', integration(world), { token: 'ghp_any' });
        expect({ what, status: response.status }).toEqual({ what, status: 503 });
        expect(await response.json()).toMatchObject({ error: { code: 'GITHUB_UNAVAILABLE' } });
      }
      stub.answer(null);
      expect((await read(world)).configured).toBe(false);

      const unreachable = await aWorld(db, githubApi('http://127.0.0.1:1'));
      const response = await unreachable.as('alice')('PUT', integration(unreachable), {
        token: 'ghp_any',
      });
      expect(response.status).toBe(503);
      expect((await read(unreachable)).configured).toBe(false);
    });
  });

  test('a member’s attempt is refused before GitHub is asked, and a stranger’s is not found', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      stub.accept('ghp_member');
      const refused = await world.as('bob')('PUT', integration(world), { token: 'ghp_member' });
      expect(refused.status).toBe(403);
      expect(stub.requests).toEqual([]);
      expect((await read(world)).configured).toBe(false);

      const elsewhere = await aWorld(db);
      const stranger = await world.as('alice')(
        'PUT',
        `/api/workspaces/${elsewhere.workspaceId}/integrations/github`,
        { token: 'ghp_member' },
      );
      expect(stranger.status).toBe(404);
      expect(stub.requests).toEqual([]);
    });
  });

  test('a token the contract refuses is 400 before GitHub is asked', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (const token of ['', 'has a space', 'x'.repeat(300)]) {
        const response = await world.as('alice')('PUT', integration(world), { token });
        expect(response.status).toBe(400);
      }
      expect(stub.requests).toEqual([]);
    });
  });

  test('a token GitHub stops accepting is shown as refused after the next card, and a replacement clears it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      stub.accept('ghp_soon_revoked');
      await world.as('alice')('PUT', integration(world), { token: 'ghp_soon_revoked' });
      // `null` is an empty body on the wire: no card.
      const unfurl = async (number: number): Promise<unknown> => {
        const response = await world.as('alice')('POST', '/api/integrations/github/unfurl', {
          workspaceId: world.workspaceId,
          url: `https://github.com/acme/api/pull/${String(number)}`,
        });
        const text = await response.text();
        return text === '' ? null : (JSON.parse(text) as unknown);
      };
      expect(await unfurl(1)).toMatchObject({ number: 1 });

      stub.revoke('ghp_soon_revoked');
      expect(await unfurl(2)).toBeNull();
      expect(await read(world)).toMatchObject({
        configured: true,
        invalidSince: clock.now().toISOString(),
      });
      // A member is not told: only an admin reads it.
      expect((await world.as('bob')('GET', integration(world))).status).toBe(403);

      stub.accept('ghp_replacement');
      await world.as('alice')('PUT', integration(world), { token: 'ghp_replacement' });
      expect(await read(world)).toMatchObject({ configured: true, invalidSince: null });
      expect(await unfurl(2)).toMatchObject({ number: 2 });
    });
  });
});
