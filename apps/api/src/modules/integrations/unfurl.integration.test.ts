/**
 * Unfurling a GitHub link (D-23, `ARCHITECTURE.md` §8.3, D-112, #66), against a real HTTP server
 * standing in for GitHub's API: the card is fetched with the workspace's own token and cached for
 * that workspace alone — so a private repository's card never reaches another — and a link that is
 * not there is cached as such, so a dead link in a busy channel costs one request, not one a render.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { credentialCipher } from '../../platform/crypto';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { setGitHubToken } from './github';
import {
  NEGATIVE_TTL_MS,
  UNAVAILABLE_TTL_MS,
  githubApi,
  unfurl,
  type UnfurlDependencies,
} from './unfurl';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const cipher = credentialCipher(Buffer.alloc(32, 9).toString('base64'));

/** GitHub, as far as these tests need it: what was asked, with which token, and what it answers. */
const asked: { path: string; authorization: string | null }[] = [];
const queried: unknown[] = [];
let answer: (path: string) => Response = () => new Response('{}', { status: 404 });
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      asked.push({ path, authorization: request.headers.get('authorization') });
      if (path === '/graphql') queried.push(await request.json());
      return answer(path);
    },
  });
});
afterAll(async () => {
  await server.stop(true);
  await closeIntegrationDatabase();
});

const pull = {
  title: 'Retry the socket with backoff',
  state: 'closed',
  merged_at: '2026-09-08T10:00:00Z',
  user: { login: 'octo', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
};
const PR = 'https://github.com/acme/api/pull/42';

/** GitHub's GraphQL answer for a pull request's checks and reviews. */
const checks = (rollup: string | null, decision: string | null): unknown => ({
  data: {
    repository: {
      pullRequest: {
        reviewDecision: decision,
        commits: {
          nodes: [{ commit: { statusCheckRollup: rollup === null ? null : { state: rollup } } }],
        },
      },
    },
  },
});

const aWorkspaceWithToken = async (
  db: Executor,
  token: string | null,
): Promise<WorkspaceContext> => {
  const room = await aRoom(db, ['alice']);
  const alice = room.members['alice'];
  if (alice === undefined) throw new Error('room');
  const context = await requireWorkspaceMembership(db, alice.userId, room.workspaceId);
  if (token !== null) await setGitHubToken(db, fixedClock(NOW), cipher, context, token);
  return context;
};

const dependencies = (
  db: Executor,
  at: Date = NOW,
  mayCallGitHub: UnfurlDependencies['mayCallGitHub'] = () => Promise.resolve(true),
): UnfurlDependencies => ({
  database: db,
  clock: fixedClock(at),
  cipher,
  github: githubApi(`http://localhost:${String(server.port)}`),
  log: aRecordingLogger().log,
  mayCallGitHub,
});

describe('integration: unfurling a GitHub link', () => {
  /**
   * Found by review: the cache is keyed by workspace and link, and any link is accepted, so one member
   * asking for links nobody wrote made a GitHub call each and could spend the workspace's token in
   * minutes. A call is now asked for first; refused, the card is a plain link, and nothing is cached,
   * so it is drawn when there is room again.
   */
  test('with no GitHub calls to spare, GitHub is not asked and nothing is kept; with room again, the card comes', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      answer = (path): Response =>
        path === '/repos/acme/api/pulls/42'
          ? Response.json(pull)
          : path === '/graphql'
            ? Response.json(checks('SUCCESS', 'APPROVED'))
            : new Response('{}', { status: 404 });
      const context = await aWorkspaceWithToken(db, 'ghp_budget');
      const charged: string[] = [];
      let room = 0;
      const spare = (workspaceId: string): Promise<boolean> => {
        charged.push(workspaceId);
        return Promise.resolve(room-- > 0);
      };
      expect(await unfurl(dependencies(db, NOW, spare), context, PR)).toBeNull();
      expect(asked).toEqual([]);
      expect(charged).toEqual([context.workspaceId]);
      room = 2;
      expect(await unfurl(dependencies(db, NOW, spare), context, PR)).toMatchObject({
        title: pull.title,
        ciStatus: 'success',
      });
      // The item and its checks: each call to GitHub is charged.
      expect(charged).toHaveLength(3);
      // Room for the item alone: the card comes without its checks, and GitHub's GraphQL is not asked.
      asked.length = 0;
      room = 1;
      answer = (path): Response =>
        path === '/repos/acme/api/pulls/43'
          ? Response.json(pull)
          : Response.json(checks('SUCCESS', null));
      const plain = await unfurl(
        dependencies(db, NOW, spare),
        context,
        'https://github.com/acme/api/pull/43',
      );
      expect(plain).toMatchObject({ title: pull.title });
      expect(plain).not.toHaveProperty('ciStatus', 'success');
      expect(asked.map((a) => a.path)).toEqual(['/repos/acme/api/pulls/43']);
    });
  });

  test('a merged pull request is its card, fetched once with the workspace’s token, then cached', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      answer = (path): Response =>
        path === '/repos/acme/api/pulls/42'
          ? Response.json(pull)
          : path === '/graphql'
            ? Response.json(checks(null, null))
            : new Response('{}', { status: 404 });
      const context = await aWorkspaceWithToken(db, 'ghp_workspace_a');
      const card = await unfurl(dependencies(db), context, PR);
      expect(card).toEqual({
        type: 'pr',
        repo: 'acme/api',
        number: 42,
        title: 'Retry the socket with backoff',
        state: 'merged',
        author: { login: 'octo', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
      });
      expect(await unfurl(dependencies(db), context, PR)).toEqual(card);
      expect(asked).toEqual([
        { path: '/repos/acme/api/pulls/42', authorization: 'Bearer ghp_workspace_a' },
        { path: '/graphql', authorization: 'Bearer ghp_workspace_a' },
      ]);
    });
  });

  test('an open pull request carries its checks and its reviews, asked of GraphQL by its parts', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      queried.length = 0;
      answer = (path): Response =>
        path === '/graphql'
          ? Response.json(checks('SUCCESS', 'APPROVED'))
          : Response.json({ ...pull, state: 'open', merged_at: null });
      const context = await aWorkspaceWithToken(db, 'ghp_workspace_a');
      expect(await unfurl(dependencies(db), context, PR)).toMatchObject({
        state: 'open',
        ciStatus: 'success',
        reviewDecision: 'approved',
      });
      expect(queried).toEqual([
        {
          query: expect.stringContaining('statusCheckRollup') as unknown,
          variables: { owner: 'acme', name: 'api', number: 42 },
        },
      ]);
    });
  });

  test.each([
    ['FAILURE', 'CHANGES_REQUESTED', 'failure', 'changes_requested'],
    ['ERROR', 'REVIEW_REQUIRED', 'failure', 'review_required'],
    ['PENDING', null, 'pending', undefined],
    ['EXPECTED', null, 'pending', undefined],
  ] as const)(
    'GitHub’s %s and %s are said as %s and %s',
    async (rollup, decision, ciStatus, reviewDecision) => {
      await withRollback(async (db) => {
        answer = (path): Response =>
          path === '/graphql' ? Response.json(checks(rollup, decision)) : Response.json(pull);
        const context = await aWorkspaceWithToken(db, 'ghp_workspace_a');
        const card = await unfurl(dependencies(db), context, PR);
        expect(card?.ciStatus).toBe(ciStatus);
        expect(card?.reviewDecision).toBe(reviewDecision);
      });
    },
  );

  test('an issue asks nothing of GraphQL', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      answer = (): Response => Response.json({ ...pull, state: 'open', merged_at: undefined });
      const context = await aWorkspaceWithToken(db, 'ghp_workspace_a');
      const card = await unfurl(dependencies(db), context, 'https://github.com/acme/api/issues/7');
      expect(card).not.toHaveProperty('ciStatus');
      expect(asked.map((a) => a.path)).toEqual(['/repos/acme/api/issues/7']);
    });
  });

  test('checks that do not come leave the card without them, said, and asked again within a minute', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      answer = (path): Response =>
        path === '/graphql' ? new Response('nope', { status: 502 }) : Response.json(pull);
      const recorded = aRecordingLogger();
      const context = await aWorkspaceWithToken(db, 'ghp_workspace_a');
      const card = await unfurl({ ...dependencies(db), log: recorded.log }, context, PR);
      expect(card).toMatchObject({ title: pull.title, state: 'merged' });
      expect(card).not.toHaveProperty('ciStatus');
      expect(recorded.lines.map((line) => line['msg'])).toContain(
        'GitHub did not answer a card’s checks',
      );
      const after = new Date(NOW.getTime() + UNAVAILABLE_TTL_MS);
      await unfurl(dependencies(db, after), context, PR);
      expect(asked.filter((a) => a.path === '/graphql')).toHaveLength(2);
    });
  });

  test('a link that is not there is none, and asked about once within the hour', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      answer = (): Response => new Response('{"message":"Not Found"}', { status: 404 });
      const context = await aWorkspaceWithToken(db, 'ghp_workspace_a');
      const issue = 'https://github.com/acme/api/issues/7';
      expect(await unfurl(dependencies(db), context, issue)).toBeNull();
      expect(
        await unfurl(
          dependencies(db, new Date(NOW.getTime() + NEGATIVE_TTL_MS - 1)),
          context,
          issue,
        ),
      ).toBeNull();
      expect(asked).toHaveLength(1);
      await unfurl(dependencies(db, new Date(NOW.getTime() + NEGATIVE_TTL_MS)), context, issue);
      expect(asked).toHaveLength(2);
    });
  });

  test('another workspace never gets a card this one’s token fetched: the cache is the workspace’s', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      answer = (): Response => Response.json(pull);
      const theirs = await aWorkspaceWithToken(db, 'ghp_workspace_a');
      const ours = await aWorkspaceWithToken(db, null);
      expect(await unfurl(dependencies(db), theirs, PR)).not.toBeNull();
      // No token here, and no borrowing from the cache another workspace filled.
      expect(await unfurl(dependencies(db), ours, PR)).toBeNull();
      expect(asked.filter((a) => a.path !== '/graphql')).toHaveLength(1);
    });
  });

  test('GitHub failing, or answering nonsense, is none for a minute, said in the log, and not a 500', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      answer = (): Response => new Response('busy', { status: 502 });
      const context = await aWorkspaceWithToken(db, 'ghp_workspace_a');
      const recorded = aRecordingLogger();
      const failing = { ...dependencies(db), log: recorded.log };
      expect(await unfurl(failing, context, PR)).toBeNull();
      expect(
        recorded.lines.find((line) => line['msg'] === 'GitHub did not answer an unfurl'),
      ).toMatchObject({
        level: 'warn',
      });
      expect(await unfurl(failing, context, PR)).toBeNull();
      expect(asked).toHaveLength(1);
      answer = (): Response => Response.json({ title: 7 });
      expect(
        await unfurl(dependencies(db, new Date(NOW.getTime() + UNAVAILABLE_TTL_MS)), context, PR),
      ).toBeNull();
      expect(asked).toHaveLength(2);
      // The token is never in what is logged.
      expect(JSON.stringify(recorded.lines)).not.toContain('ghp_workspace_a');
    });
  });

  test('a token that no longer opens — the key was changed — is said at error, and no card is drawn', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      answer = (): Response => Response.json(pull);
      const context = await aWorkspaceWithToken(db, 'ghp_sealed_under_the_old_key');
      const recorded = aRecordingLogger();
      const rotated = {
        ...dependencies(db),
        cipher: credentialCipher(Buffer.alloc(32, 8).toString('base64')),
        log: recorded.log,
      };
      expect(await unfurl(rotated, context, PR)).toBeNull();
      expect(
        recorded.lines.find((line) => String(line['msg']).includes('does not open')),
      ).toMatchObject({ level: 'error', workspaceId: context.workspaceId });
      expect(asked).toEqual([]);
    });
  });

  test('anything else that fails while opening it is not taken for a changed key: it is thrown', async () => {
    await withRollback(async (db) => {
      const context = await aWorkspaceWithToken(db, 'ghp_workspace_a');
      const failing = {
        ...dependencies(db),
        cipher: {
          seal: cipher.seal,
          open: (): Promise<string> => Promise.reject(new TypeError('the cipher broke')),
        },
      };
      const thrown = await unfurl(failing, context, PR).then(
        () => null,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(TypeError);
    });
  });
});
