/**
 * What chat's GitHub-facing routes share (`wiring.ts`, D-280): GitHub's API is the real one at the address the sign-in
 * uses, read through the application's clock, unless a test hands its own.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { fixedClock } from '../../../platform/clock';
import { inProcessLimiters } from '../../../realtime/rate-limiter';
import { NOW } from '../../../testing/doubles';
import type { ChatRouteDependencies } from './dependencies';
import type { GitHubApi } from '../integrations/unfurl';
import { githubWiring } from './wiring';

const clock = fixedClock(NOW);
const contextAt = (apiUrl: string, githubApi?: GitHubApi): ChatRouteDependencies =>
  ({
    config: { GITHUB_API_URL: apiUrl },
    clock,
    limiterFor: inProcessLimiters(clock),
    githubApi,
  }) as unknown as ChatRouteDependencies;

const failing = Bun.serve({ port: 0, fetch: () => new Response('down', { status: 500 }) });
afterAll(async () => {
  await failing.stop(true);
});

describe('chat’s GitHub wiring', () => {
  test('talks to the address it is given, and a failure is read against the application’s clock', async () => {
    const { github } = githubWiring(contextAt(`http://localhost:${String(failing.port)}`));
    const failure = await github.check('a-token').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('GitHub answered 500');
  });

  test('uses the API a test hands it, and makes none of its own', () => {
    const own = {} as GitHubApi;
    expect(githubWiring(contextAt('http://unused.test', own)).github).toBe(own);
  });
});
