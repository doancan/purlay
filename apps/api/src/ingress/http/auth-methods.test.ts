/**
 * How this server signs people in, asked before anybody is (#81, D-138 §6): GitHub always, email only
 * where the instance has a relay to mail a link through — what the server's settings say (D-179 §6).
 * Answered without a session and without a query: the database below has never connected and cannot.
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { unconnectedDatabase } from '@purlay/db';
import { AuthMethods } from '@purlay/types';
import { aRecordingOutbox, testConfig, testDependencies } from '../../testing/doubles';
import { aTestAuth } from '../../testing/signed-in';
import { anOidcStub } from '../../testing/oidc-stub';
import { createApp } from './app';

const ask = async (withMail: boolean, withGitHub = true): Promise<[number, unknown]> => {
  const config = testConfig();
  if (!withGitHub) {
    delete config.GITHUB_CLIENT_ID;
    delete config.GITHUB_CLIENT_SECRET;
  }
  const app = createApp(
    testDependencies({
      database: unconnectedDatabase(),
      config,
      ...(withMail ? { mail: aRecordingOutbox() } : {}),
    }),
  );
  const response = await app.handle(new Request('https://purlay.test/api/auth/methods'));
  return [response.status, await response.json()];
};

describe('the ways in', () => {
  test('each of GitHub and email is on when the server has it, off when it has not — for anybody, signed in or not', async () => {
    expect(await ask(false)).toEqual([
      200,
      { github: true, email: false, oidc: null, signUp: 'invite-only', password: true },
    ]);
    const [status, body] = await ask(true);
    expect(status).toBe(200);
    expect(Value.Check(AuthMethods, body)).toBe(true);
    expect(body).toEqual({
      github: true,
      email: true,
      oidc: null,
      signUp: 'invite-only',
      password: true,
    });
    expect(await ask(true, false)).toEqual([
      200,
      { github: false, email: true, oidc: null, signUp: 'invite-only', password: true },
    ]);
  });

  test('a server with neither is a server waiting for its setup, and says so with two false', async () => {
    const [status, body] = await ask(false, false);
    expect(status).toBe(200);
    expect(Value.Check(AuthMethods, body)).toBe(true);
    expect(body).toEqual({
      github: false,
      email: false,
      oidc: null,
      signUp: 'invite-only',
      password: true,
    });
  });

  test('single sign-on is on when a provider is connected: its label, or null for the default the client words', async () => {
    const asked = async (name: string | undefined): Promise<unknown> => {
      const auth = aTestAuth(unconnectedDatabase(), {
        settings: {
          github: undefined,
          oidc: { issuer: 'https://idp.example.test', clientId: 'id', clientSecret: 's', name },
          signUp: 'invite-only',
        },
      });
      const app = createApp(testDependencies({ database: unconnectedDatabase(), auth }));
      const response = await app.handle(new Request('https://purlay.test/api/auth/methods'));
      return await response.json();
    };
    const named = await asked('Acme SSO');
    expect(Value.Check(AuthMethods, named)).toBe(true);
    expect(named).toEqual({
      github: false,
      email: false,
      oidc: { name: 'Acme SSO' },
      signUp: 'invite-only',
      password: true,
    });
    expect(await asked(undefined)).toEqual({
      github: false,
      email: false,
      oidc: { name: null },
      signUp: 'invite-only',
      password: true,
    });
  });

  test('asking which ways are on connects to nobody: the provider is asked nothing until somebody presses its button', async () => {
    const stub = await anOidcStub({ sub: 's', email: 'a@example.test' });
    const auth = aTestAuth(unconnectedDatabase(), {
      settings: {
        github: undefined,
        oidc: {
          issuer: stub.issuer(),
          clientId: 'purlay-client',
          clientSecret: 'x',
          name: undefined,
        },
        signUp: 'invite-only',
      },
      fetch: stub.fetch,
    });
    const app = createApp(testDependencies({ database: unconnectedDatabase(), auth }));
    await app.handle(new Request('https://purlay.test/api/auth/methods'));
    expect(stub.calls.urls).toEqual([]);
  });
});

describe('GitHub sign-in with no GitHub connected', () => {
  const ask = async (path: string, init?: RequestInit): Promise<Response> => {
    const config = testConfig();
    delete config.GITHUB_CLIENT_ID;
    delete config.GITHUB_CLIENT_SECRET;
    const app = createApp(testDependencies({ database: unconnectedDatabase(), config }));
    return await app.handle(new Request(`https://purlay.test${path}`, init));
  };
  const press = async (): Promise<Response> => await ask('/auth/github');

  test('the library’s own social route is the same 404, not its 500', async () => {
    const answered = await ask('/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://purlay.test' },
      body: JSON.stringify({ provider: 'github', callbackURL: 'https://purlay.test' }),
    });
    expect(answered.status).toBe(404);
    expect(await answered.json()).toMatchObject({
      error: { code: 'ROUTE_NOT_FOUND' },
    });
  });

  test('a callback that arrives anyway is a browser: sent to the sign-in screen as an expired try', async () => {
    const answered = await ask('/auth/callback/github?code=x&state=y');
    expect([answered.status, answered.headers.get('location')]).toEqual([
      302,
      'https://purlay.test/sign-in?error=expired',
    ]);
  });

  test('is a 404 in the API’s own shape, not the library’s thrown error and not a redirect', async () => {
    const answered = await press();
    expect(answered.status).toBe(404);
    expect(answered.headers.get('set-cookie')).toBeNull();
    expect(answered.headers.get('location')).toBeNull();
    expect(answered.headers.get('content-type')).toContain('application/json');
    expect(await answered.json()).toEqual({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'GitHub sign-in is not set up on this server.',
      },
    });
  });
});
