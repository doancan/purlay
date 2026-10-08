/**
 * The GitHub client against a real HTTP server standing in for GitHub.
 *
 * The client's job is to refuse what GitHub can send that is not a usable
 * identity — a 200 carrying an error, a profile without an id, a list that is not
 * a list — so those answers are served for real and the refusals asserted. A
 * mocked `fetch` would test the mock (D-38).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { githubClient, type GitHubClient } from './github';

interface Reply {
  status: number;
  body: unknown;
}

let server: ReturnType<typeof Bun.serve>;
const replies = new Map<string, Reply>();
const seen: { path: string; authorization: string | null; body: string }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      seen.push({
        path,
        authorization: request.headers.get('authorization'),
        body: await request.text(),
      });
      const reply = replies.get(path) ?? { status: 404, body: { message: 'Not Found' } };
      return Response.json(reply.body, { status: reply.status });
    },
  });
});

afterAll(async () => {
  await server.stop(true);
});

const client = (): GitHubClient => {
  const base = `http://localhost:${String(server.port)}`;
  return githubClient(
    {
      clientId: 'id',
      clientSecret: 'secret',
      redirectUri: 'https://purlay.test/auth/github/callback',
    },
    { oauth: base, api: base },
  );
};

const refusal = async (attempt: () => Promise<unknown>): Promise<string> =>
  await attempt().then(
    () => 'accepted',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

describe('the GitHub client', () => {
  test('exchanges a code for a token, sending the credentials GitHub expects', async () => {
    replies.set('/login/oauth/access_token', { status: 200, body: { access_token: 'gho_token' } });
    expect(await client().exchangeCode('the-code')).toBe('gho_token');
    const sent = JSON.parse(seen.at(-1)?.body ?? '{}') as Record<string, unknown>;
    expect(sent).toEqual({
      client_id: 'id',
      client_secret: 'secret',
      redirect_uri: 'https://purlay.test/auth/github/callback',
      code: 'the-code',
    });
  });

  test('a 200 that carries an error is refused, not passed on as an empty token', async () => {
    replies.set('/login/oauth/access_token', {
      status: 200,
      body: { error: 'bad_verification_code' },
    });
    expect(await refusal(() => client().exchangeCode('stale'))).toBe(
      'GitHub returned no access token',
    );
  });

  test('a status GitHub refuses with is an error that names the request', async () => {
    replies.set('/user', { status: 401, body: { message: 'Bad credentials' } });
    expect(await refusal(() => client().profile('t'))).toBe(
      'GitHub refused the profile request: 401',
    );
  });

  test('a profile is read with the token, and optional fields become null', async () => {
    replies.set('/user', { status: 200, body: { id: 42, login: 'mona' } });
    expect(await client().profile('gho_token')).toEqual({
      id: 42,
      login: 'mona',
      name: null,
      avatarUrl: null,
    });
    expect(seen.at(-1)?.authorization).toBe('Bearer gho_token');
  });

  test('a profile without an id or a login is refused', async () => {
    replies.set('/user', { status: 200, body: { login: 'no-id' } });
    expect(await refusal(() => client().profile('t'))).toBe(
      'GitHub returned a profile without an id or a login',
    );
  });

  test('emails keep their flags, and entries without an address are dropped', async () => {
    replies.set('/user/emails', {
      status: 200,
      body: [
        { email: 'mona@example.test', primary: true, verified: true },
        { email: 'old@example.test', primary: false, verified: 'yes' },
        { primary: true },
        null,
      ],
    });
    expect(await client().emails('t')).toEqual([
      { email: 'mona@example.test', primary: true, verified: true },
      { email: 'old@example.test', primary: false, verified: false },
    ]);
  });

  test('emails that are not a list are refused by name, not by a TypeError', async () => {
    replies.set('/user/emails', { status: 200, body: { message: 'rate limited' } });
    expect(await refusal(() => client().emails('t'))).toBe(
      'GitHub returned emails that are not a list',
    );
  });
});
