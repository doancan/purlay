/**
 * The unfurl when GitHub refuses the workspace's token or its calls (D-23, amended; #884), against
 * the GitHub API stand-in (`aGitHubApiStub`) and the real client: a `401` is a token marked bad and
 * not asked with again until it is replaced; a `403` or `429` that says when to return is a workspace
 * paused until then; and a plain `403` or a `5xx` is only GitHub failing, held off for a minute as it
 * always was. Nothing here reaches the real GitHub.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import type { GitHubCardMetadata } from '@purlay/types';
import { credentialCipher } from '../../platform/crypto';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { aMovableClock, aRecordingLogger } from '../../testing/doubles';
import { aGitHubApiStub, type GitHubApiStub } from '../../testing/github-stub';
import { aRoom } from '../../testing/rooms';
import { githubIntegrationOf, removeGitHubToken, setGitHubToken } from './github';
import {
  GitHubRefused,
  UNAVAILABLE_TTL_MS,
  githubApi,
  inProcessPauses,
  unfurl,
  type GitHubApi,
  type GitHubPauses,
} from './unfurl';

const cipher = credentialCipher(Buffer.alloc(32, 9).toString('base64'));
const link = (number: number): string => `https://github.com/acme/api/pull/${String(number)}`;

let stub: GitHubApiStub;
beforeAll(() => {
  stub = aGitHubApiStub();
});
afterAll(async () => {
  await stub.stop();
  await closeIntegrationDatabase();
});

/** Everything a scenario moves: time, GitHub's answers, the pauses, and what was logged. */
const aScenario = (): {
  readonly clock: ReturnType<typeof aMovableClock>;
  readonly pauses: GitHubPauses;
  readonly logs: ReturnType<typeof aRecordingLogger>;
  readonly card: (
    db: Executor,
    context: WorkspaceContext,
    number: number,
    api?: GitHubApi,
  ) => Promise<GitHubCardMetadata | null>;
} => {
  stub.answer(null);
  stub.requests.length = 0;
  const clock = aMovableClock();
  const pauses = inProcessPauses();
  const logs = aRecordingLogger();
  return {
    clock,
    pauses,
    logs,
    card: async (db, context, number, api) =>
      await unfurl(
        {
          database: db,
          clock,
          cipher,
          github: api ?? githubApi(stub.url, () => clock.now().getTime()),
          log: logs.log,
          mayCallGitHub: () => Promise.resolve(true),
          pauses,
        },
        context,
        link(number),
      ),
  };
};

const aWorkspaceWithToken = async (
  db: Executor,
  name: string,
  token: string,
  clock: ReturnType<typeof aMovableClock>,
): Promise<WorkspaceContext> => {
  const room = await aRoom(db, [name]);
  const member = room.members[name];
  if (member === undefined) throw new Error('room');
  const context = await requireWorkspaceMembership(db, member.userId, room.workspaceId);
  stub.accept(token);
  await setGitHubToken(db, clock, cipher, context, token);
  return context;
};

const rateLimited =
  (headers: Record<string, string>, status = 403) =>
  (): Response =>
    Response.json({ message: 'API rate limit exceeded' }, { status, headers });

/** How many links' answers are kept (the transaction is the test's own, so these are its). */
const kept = async (db: Executor): Promise<number> =>
  Number(
    (
      await db
        .selectFrom('link_previews')
        .select((eb) => eb.fn.countAll().as('count'))
        .executeTakeFirstOrThrow()
    ).count,
  );

describe('integration: GitHub refuses the token (401)', () => {
  test('the token is marked bad once, GitHub is not asked again — not even for a card kept — and a replacement clears it', async () => {
    await withRollback(async (db) => {
      const { card, clock, logs } = aScenario();
      const context = await aWorkspaceWithToken(db, 'alice', 'ghp_first', clock);
      expect(await card(db, context, 1)).toMatchObject({ title: 'Retry the socket with backoff' });
      expect(await githubIntegrationOf(db, context)).toMatchObject({
        configured: true,
        invalidSince: null,
      });

      // Revoked at GitHub: the next link asks, is refused, and the token is written off.
      stub.revoke('ghp_first');
      clock.advance(60_000);
      expect(await card(db, context, 2)).toBeNull();
      const marked = await githubIntegrationOf(db, context);
      expect(marked).toMatchObject({ configured: true, invalidSince: clock.now().toISOString() });
      expect(logs.lines.map((line) => line['msg'])).toContain(
        'GitHub refused the workspace’s token: it was revoked or has expired',
      );

      // From now on no call is made, for a new link or for the card the cache still holds.
      const asked = stub.requests.length;
      expect(await card(db, context, 3)).toBeNull();
      expect(await card(db, context, 1)).toBeNull();
      expect(stub.requests).toHaveLength(asked);
      // Nothing was cached for the refused link: it is not "missing", it is not asked.
      expect(await kept(db)).toBe(1);

      // Replaced by an admin: cleared, and cards are drawn again with the new token.
      stub.accept('ghp_second');
      clock.advance(1000);
      await setGitHubToken(db, clock, cipher, context, 'ghp_second');
      expect(await githubIntegrationOf(db, context)).toMatchObject({ invalidSince: null });
      expect(await card(db, context, 2)).toMatchObject({ number: 2 });
      expect(stub.requests.at(-1)?.token).toBe('ghp_second');
    });
  });

  test('removing a token that was marked bad clears the mark, and a token set again starts clean', async () => {
    await withRollback(async (db) => {
      const { card, clock } = aScenario();
      const context = await aWorkspaceWithToken(db, 'alice', 'ghp_removed', clock);
      stub.revoke('ghp_removed');
      expect(await card(db, context, 1)).toBeNull();
      expect(await githubIntegrationOf(db, context)).toMatchObject({
        invalidSince: expect.any(String) as string,
      });
      await removeGitHubToken(db, clock, context);
      expect(await githubIntegrationOf(db, context)).toEqual({
        configured: false,
        updatedAt: null,
        invalidSince: null,
        broadScopes: false,
      });
      stub.accept('ghp_again');
      await setGitHubToken(db, clock, cipher, context, 'ghp_again');
      expect(await githubIntegrationOf(db, context)).toMatchObject({
        configured: true,
        invalidSince: null,
      });
      expect(await card(db, context, 1)).not.toBeNull();
    });
  });

  test('a token replaced while GitHub was being asked is not written off for the old one’s refusal', async () => {
    await withRollback(async (db) => {
      const { card, clock } = aScenario();
      const context = await aWorkspaceWithToken(db, 'alice', 'ghp_old', clock);
      stub.accept('ghp_new');
      // GitHub refuses the old token, and by then an admin has saved a new one.
      const slow: GitHubApi = {
        item: async () => {
          clock.advance(1000);
          await setGitHubToken(db, clock, cipher, context, 'ghp_new');
          throw new GitHubRefused({ kind: 'token_invalid' });
        },
        checks: () => Promise.resolve({}),
        check: () => Promise.resolve({ scopes: null }),
      };
      expect(await card(db, context, 1, slow)).toBeNull();
      expect(await githubIntegrationOf(db, context)).toMatchObject({ invalidSince: null });
      expect(await card(db, context, 2)).not.toBeNull();
    });
  });

  test('a 401 on a pull request’s checks marks the token too, and the card comes without them', async () => {
    await withRollback(async (db) => {
      const { card, clock } = aScenario();
      const context = await aWorkspaceWithToken(db, 'alice', 'ghp_checks', clock);
      stub.answer((path) =>
        path === '/graphql' ? Response.json({ message: 'Bad credentials' }, { status: 401 }) : null,
      );
      const drawn = await card(db, context, 1);
      expect(drawn).toMatchObject({ title: 'Retry the socket with backoff' });
      expect(drawn).not.toHaveProperty('ciStatus');
      expect(await githubIntegrationOf(db, context)).toMatchObject({
        invalidSince: expect.any(String) as string,
      });
    });
  });
});

describe('integration: GitHub is not taking the workspace’s calls (403, 429)', () => {
  test('a primary limit pauses the workspace until its reset: no call, nothing kept, then it resumes', async () => {
    await withRollback(async (db) => {
      const { card, clock } = aScenario();
      const context = await aWorkspaceWithToken(db, 'alice', 'ghp_primary', clock);
      const reset = String((clock.now().getTime() + 10 * 60_000) / 1000);
      stub.answer(rateLimited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }));
      expect(await card(db, context, 1)).toBeNull();
      expect(stub.requests).toHaveLength(1);
      // The token is fine, and nothing is cached: the answer was not about the link.
      expect(await githubIntegrationOf(db, context)).toMatchObject({ invalidSince: null });
      expect(await kept(db)).toBe(0);

      // Paused: even with GitHub well again, nothing is asked until the reset.
      stub.answer(null);
      clock.advance(9 * 60_000);
      expect(await card(db, context, 1)).toBeNull();
      expect(await card(db, context, 2)).toBeNull();
      expect(stub.requests).toHaveLength(1);

      clock.advance(60_000 + 1);
      expect(await card(db, context, 1)).not.toBeNull();
      expect(stub.requests.length).toBeGreaterThan(1);
    });
  });

  test('a secondary limit waits Retry-After, and a 429 that says nothing waits a minute', async () => {
    await withRollback(async (db) => {
      const { card, clock } = aScenario();
      const context = await aWorkspaceWithToken(db, 'alice', 'ghp_secondary', clock);
      stub.answer(rateLimited({ 'retry-after': '30' }));
      expect(await card(db, context, 1)).toBeNull();
      stub.answer(null);
      clock.advance(29_000);
      expect(await card(db, context, 1)).toBeNull();
      expect(stub.requests).toHaveLength(1);
      clock.advance(1001);
      expect(await card(db, context, 1)).not.toBeNull();

      // A 429 with neither header: the minute GitHub advises.
      stub.answer(rateLimited({}, 429));
      clock.advance(10 * 60_000);
      expect(await card(db, context, 7)).toBeNull();
      stub.answer(null);
      const asked = stub.requests.length;
      clock.advance(59_000);
      expect(await card(db, context, 8)).toBeNull();
      expect(stub.requests).toHaveLength(asked);
      clock.advance(1001);
      expect(await card(db, context, 8)).not.toBeNull();
    });
  });

  test('a pull request’s checks refused for the quota give the card without them, and pause the workspace', async () => {
    await withRollback(async (db) => {
      const { card, clock } = aScenario();
      const context = await aWorkspaceWithToken(db, 'alice', 'ghp_checks_limit', clock);
      stub.answer((path) => (path === '/graphql' ? rateLimited({ 'retry-after': '120' })() : null));
      const drawn = await card(db, context, 1);
      expect(drawn).toMatchObject({ title: 'Retry the socket with backoff' });
      expect(drawn).not.toHaveProperty('ciStatus');
      stub.answer(null);
      const asked = stub.requests.length;
      expect(await card(db, context, 2)).toBeNull();
      expect(stub.requests).toHaveLength(asked);
      // The card without its checks is the one kept for a minute, as an outage's is.
      clock.advance(UNAVAILABLE_TTL_MS + 120_000);
      expect(await card(db, context, 1)).toMatchObject({ ciStatus: 'success' });
    });
  });

  test('a pause is the workspace’s: another workspace is still served, and a bad token of one is no one else’s', async () => {
    await withRollback(async (db) => {
      const { card, clock, pauses } = aScenario();
      const paused = await aWorkspaceWithToken(db, 'alice', 'ghp_paused', clock);
      const other = await aWorkspaceWithToken(db, 'bob', 'ghp_other', clock);
      stub.answer(rateLimited({ 'retry-after': '600' }));
      expect(await card(db, paused, 1)).toBeNull();
      stub.answer(null);
      expect(pauses.until(paused.workspaceId, clock.now().getTime())).not.toBeNull();
      expect(pauses.until(other.workspaceId, clock.now().getTime())).toBeNull();

      stub.requests.length = 0;
      expect(await card(db, other, 1)).not.toBeNull();
      expect(stub.requests.map((request) => request.token)).toContain('ghp_other');
      expect(stub.requests.map((request) => request.token)).not.toContain('ghp_paused');
      expect(await card(db, paused, 2)).toBeNull();

      // And a token written off for one is no mark on the other's.
      stub.revoke('ghp_paused');
      clock.advance(11 * 60_000);
      expect(await card(db, paused, 3)).toBeNull();
      expect(await githubIntegrationOf(db, paused)).toMatchObject({
        invalidSince: expect.any(String) as string,
      });
      expect(await githubIntegrationOf(db, other)).toMatchObject({ invalidSince: null });
      expect(await card(db, other, 4)).not.toBeNull();
    });
  });
});

describe('integration: GitHub failing is not a refusal', () => {
  test('a 403 that names no time and a 5xx are held off a minute for the link: not a pause, not a bad token', async () => {
    await withRollback(async (db) => {
      const { card, clock, pauses } = aScenario();
      const context = await aWorkspaceWithToken(db, 'alice', 'ghp_failing', clock);
      for (const [number, status] of [
        [1, 403],
        [2, 500],
        [3, 503],
      ] as const) {
        stub.answer(() => new Response('{}', { status }));
        expect(await card(db, context, number)).toBeNull();
      }
      stub.answer(null);
      expect(pauses.until(context.workspaceId, clock.now().getTime())).toBeNull();
      expect(await githubIntegrationOf(db, context)).toMatchObject({ invalidSince: null });

      // A link that failed is not asked again for a minute; another link is asked at once.
      const asked = stub.requests.length;
      expect(await card(db, context, 1)).toBeNull();
      expect(stub.requests).toHaveLength(asked);
      expect(await card(db, context, 4)).not.toBeNull();
      clock.advance(UNAVAILABLE_TTL_MS + 1);
      expect(await card(db, context, 1)).not.toBeNull();
    });
  });
});
