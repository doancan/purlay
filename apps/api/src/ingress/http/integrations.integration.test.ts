/**
 * `POST /api/integrations/github/unfurl` through the HTTP surface (#66): the answer read against the
 * contract, a link that is not a GitHub pull request or issue refused by name before anything is
 * fetched, and a stranger told the workspace does not exist. The cache and the token are the
 * module's (`unfurl.integration.test.ts`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { UnfurlResponse } from '@purlay/types';
import { createApp } from './app';
import { fixedClock } from '../../platform/clock';
import type { GitHubApi } from '../../modules/integrations/unfurl';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);
const asked: string[] = [];
const github: GitHubApi = {
  item: (part) => {
    asked.push(`${part.owner}/${part.repo}/${part.kind}/${String(part.number)}`);
    return Promise.resolve({
      type: 'pr',
      repo: `${part.owner}/${part.repo}`,
      number: part.number,
      title: 'A change',
      state: 'open',
      author: { login: 'octo', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
    });
  },
  // No checks for these cards: what the endpoint does with them is the module's test (#423).
  checks: () => Promise.resolve({}),
};

const call = async (
  db: Executor,
  method: string,
  path: string,
  who: SignedInUser,
  body?: unknown,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock, githubApi: github })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: { cookie: who.cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

describe('integration: unfurling over HTTP', () => {
  test('a member gets the card as the contract has it; a stranger is told the workspace is not there', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      const owner = await aSignedInUser(db, clock, 'uf-owner');
      const stranger = await aSignedInUser(db, clock, 'uf-stranger');
      const slug = aUniqueSlug('uf');
      const created = await call(db, 'POST', '/api/workspaces', owner, { name: slug, slug });
      const workspaceId = ((await created.json()) as { id: string }).id;
      expect(
        (
          await call(db, 'PUT', `/api/workspaces/${workspaceId}/integrations/github`, owner, {
            token: 'ghp_http',
          })
        ).status,
      ).toBe(204);

      const url = 'https://github.com/acme/api/pull/9';
      const answered = await call(db, 'POST', '/api/integrations/github/unfurl', owner, {
        workspaceId,
        url,
      });
      expect(answered.status).toBe(200);
      const card: unknown = await answered.json();
      expect(Value.Check(UnfurlResponse, card)).toBe(true);
      expect(card).toMatchObject({ type: 'pr', repo: 'acme/api', number: 9 });

      const across = await call(db, 'POST', '/api/integrations/github/unfurl', stranger, {
        workspaceId,
        url,
      });
      expect(across.status).toBe(404);
      expect(await across.json()).toMatchObject({ error: { code: 'WORKSPACE_NOT_FOUND' } });
      expect(asked).toEqual(['acme/api/pull/9']);
    });
  });

  test('anything but a GitHub pull request or issue is refused by name, and nothing is fetched', async () => {
    await withRollback(async (db) => {
      asked.length = 0;
      const owner = await aSignedInUser(db, clock, 'uf-owner2');
      const slug = aUniqueSlug('uf2');
      const created = await call(db, 'POST', '/api/workspaces', owner, { name: slug, slug });
      const workspaceId = ((await created.json()) as { id: string }).id;
      for (const url of [
        'http://169.254.169.254/latest/meta-data',
        'https://github.com.evil.test/acme/api/pull/1',
        'https://github.com/acme/api/pull/1/../../../user',
        'https://gist.github.com/acme/1',
        // A repository named `.` or `..` would be resolved out of `/repos/{owner}/{repo}` (#66).
        'https://github.com/acme/../pull/1',
        'https://github.com/acme/./pull/1',
      ]) {
        const refused = await call(db, 'POST', '/api/integrations/github/unfurl', owner, {
          workspaceId,
          url,
        });
        expect({ url, status: refused.status }).toEqual({ url, status: 400 });
        expect(await refused.json()).toMatchObject({
          error: {
            code: 'VALIDATION_FAILED',
            details: { fields: { url: expect.any(String) as string } },
          },
        });
      }
      expect(asked).toEqual([]);
    });
  });
});
