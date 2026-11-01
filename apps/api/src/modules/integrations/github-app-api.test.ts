/**
 * How GitHub's answers are read by the App (D-246 §4): a limit is a wait, by whichever header says it; a `401`
 * is a token not good any more; a `5xx`, a redirect, a body that is not what was asked, or no answer in time is
 * GitHub unavailable — each one error, and none of them carrying a token.
 */
import { describe, expect, test } from 'bun:test';
import {
  GitHubRateLimited,
  GitHubUnauthorized,
  GitHubUnavailable,
  githubAppApi,
  githubAppCaller,
  limitOf,
  tokenAnswer,
  type GitHubAppFetch,
} from './github-app-api';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const URLS = { web: 'https://github.example', api: 'https://api.github.example' };

const answering =
  (response: () => Response | Promise<Response>): GitHubAppFetch =>
  async () =>
    await response();

const failure = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
};

describe('a limit, as GitHub says one', () => {
  test('Retry-After, the reset of an exhausted quota, or a minute; a plain 403 is no limit', () => {
    const status = (code: number, headers: Record<string, string> = {}): Response =>
      new Response('', { status: code, headers });
    expect(limitOf(status(403, { 'retry-after': '30' }), NOW)).toBe(30);
    expect(limitOf(status(429, { 'retry-after': '0' }), NOW)).toBe(1);
    const reset = String(NOW.getTime() / 1000 + 120);
    expect(
      limitOf(status(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }), NOW),
    ).toBe(120);
    expect(limitOf(status(403, { 'x-ratelimit-remaining': '0' }), NOW)).toBe(60);
    expect(limitOf(status(429), NOW)).toBe(60);
    expect(limitOf(status(403), NOW)).toBeNull();
    expect(limitOf(status(403, { 'retry-after': 'soon' }), NOW)).toBeNull();
    expect(limitOf(status(200, { 'retry-after': '30' }), NOW)).toBeNull();
  });
});

describe('one call to GitHub', () => {
  const api = (fetch: GitHubAppFetch, timeoutMs?: number): ReturnType<typeof githubAppApi> =>
    githubAppApi(
      githubAppCaller(fetch, () => NOW, timeoutMs),
      URLS,
    );

  test('names its token, asks for GitHub’s media type, follows no redirect and has a deadline', async () => {
    const seen: Parameters<GitHubAppFetch>[] = [];
    const fetch: GitHubAppFetch = async (url, init) => {
      seen.push([url, init]);
      return await Promise.resolve(Response.json({ id: 9, login: 'octo' }));
    };
    expect(await api(fetch).user('ghu_token')).toEqual({ id: 9, login: 'octo' });
    const [url, init] = seen[0] ?? ['', undefined];
    expect(url).toBe('https://api.github.example/user');
    expect(init?.headers).toMatchObject({
      authorization: 'Bearer ghu_token',
      accept: 'application/vnd.github+json',
    });
    expect(init?.redirect).toBe('manual');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  test('each failure is its error', async () => {
    expect(
      await failure(
        api(
          answering(() => new Response('', { status: 403, headers: { 'retry-after': '7' } })),
        ).user('t'),
      ),
    ).toEqual(new GitHubRateLimited(7));
    expect(
      await failure(api(answering(() => new Response('', { status: 401 }))).user('t')),
    ).toBeInstanceOf(GitHubUnauthorized);
    for (const response of [
      (): Response => new Response('', { status: 502 }),
      (): Response => new Response('', { status: 302, headers: { location: 'https://elsewhere' } }),
      (): Response => new Response('not json'),
      (): Response => Response.json({ id: 'nine' }),
      (): Response => new Response('', { status: 404 }),
    ]) {
      expect(await failure(api(answering(response)).user('t'))).toBeInstanceOf(GitHubUnavailable);
    }
    const unreachable: GitHubAppFetch = async () =>
      await Promise.reject(new TypeError('fetch failed'));
    expect(String(await failure(api(unreachable).user('t')))).toContain('could not be reached');
    const hanging: GitHubAppFetch = async (_url, init) =>
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(init.signal.reason as Error);
        });
      });
    expect(String(await failure(api(hanging, 10).user('t')))).toContain('did not answer in time');
  });

  test('a token request is the tokens, or GitHub’s refusal of the grant', async () => {
    expect(
      await tokenAnswer(
        Response.json({
          access_token: 'ghu_a',
          expires_in: 28800,
          refresh_token: 'ghr_b',
          refresh_token_expires_in: 15897600,
        }),
      ),
    ).toEqual({
      accessToken: 'ghu_a',
      accessExpiresIn: 28800,
      refreshToken: 'ghr_b',
      refreshExpiresIn: 15897600,
    });
    // An App whose tokens do not expire gives neither expiry nor refresh token.
    expect(await tokenAnswer(Response.json({ access_token: 'ghu_a' }))).toEqual({
      accessToken: 'ghu_a',
      accessExpiresIn: null,
      refreshToken: null,
      refreshExpiresIn: null,
    });
    expect(await tokenAnswer(Response.json({ error: 'bad_verification_code' }))).toBe('refused');
    expect(await tokenAnswer(Response.json({ error: 'Not Found' }, { status: 404 }))).toBe(
      'refused',
    );
    expect(await failure(tokenAnswer(new Response('', { status: 400 })))).toBeInstanceOf(
      GitHubUnavailable,
    );
  });

  test('an installation GitHub has none of is missing; the App is read as itself', async () => {
    expect(
      await api(answering(() => new Response('', { status: 404 }))).installation('jwt', 5),
    ).toBe('missing');
    expect(
      await api(
        answering(() => Response.json({ id: 1, slug: 'purlay', client_id: 'Iv23.x', name: 'P' })),
      ).app('jwt'),
    ).toEqual({ id: 1, slug: 'purlay', clientId: 'Iv23.x' });
  });
});
