/**
 * Administration → Server's client: which request each call sends (path, verb, body), that an answer
 * is read as the shared guards read it, and that a refusal's reason reaches the caller.
 */
import { describe, expect, test } from 'bun:test';
import type { ProbeResult } from '@purlay/types';
import { isSetupFailure, type SetupFailure, type SetupFetch } from '../setup/client';
import { createServerClient } from './server-client';

interface Seen {
  readonly path: string;
  readonly init: RequestInit;
}

const world = (
  status: number,
  body: string,
): { readonly seen: Seen[]; readonly fetch: SetupFetch } => {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: (path, init): Promise<Response> => {
      seen.push({ path, init });
      return Promise.resolve(new Response(body, { status }));
    },
  };
};

const ANSWER = {
  settings: { signUp: 'invite-only' },
  needsReentry: [],
  appUrl: 'https://purlay.test',
  githubCallbackUrl: 'https://purlay.test/auth/callback/github',
  oidcCallbackUrl: 'https://purlay.test/auth/callback/oidc',
  channels: { github: true, email: false, oidc: false },
  adminEmail: 'admin@example.test',
};

const failureOf = async (promise: Promise<unknown>): Promise<SetupFailure> => {
  try {
    await promise;
  } catch (error) {
    if (isSetupFailure(error)) return error;
    throw error;
  }
  throw new Error('the call did not fail');
};

describe('reading the settings', () => {
  test('asks GET /api/server/settings, with the abort signal, and returns the answer', async () => {
    const w = world(200, JSON.stringify(ANSWER));
    const controller = new AbortController();
    const answer = await createServerClient(w.fetch).settings(controller.signal);
    expect(answer.adminEmail).toBe('admin@example.test');
    expect(w.seen[0]?.path).toBe('/api/server/settings');
    expect(w.seen[0]?.init.method).toBe('GET');
    expect(w.seen[0]?.init.signal).toBe(controller.signal);
  });

  test('refuses an answer that lacks what the page reads', async () => {
    for (const broken of [
      { ...ANSWER, adminEmail: 3 },
      { ...ANSWER, channels: { github: true } },
      { ...ANSWER, needsReentry: 'x' },
      { ...ANSWER, appUrl: undefined },
    ]) {
      const failure = await failureOf(
        createServerClient(world(200, JSON.stringify(broken)).fetch).settings(),
      );
      expect(failure.code).toBe('MALFORMED');
    }
  });
});

describe('trying a channel', () => {
  test('posts the GitHub candidate and returns the verdict', async () => {
    const w = world(200, JSON.stringify({ ok: true }));
    const verdict = await createServerClient(w.fetch).github({ clientId: 'a', clientSecret: 'b' });
    expect(verdict).toEqual({ ok: true });
    expect(w.seen[0]?.path).toBe('/api/server/github');
    expect(w.seen[0]?.init.method).toBe('POST');
    expect(w.seen[0]?.init.body).toBe('{"clientId":"a","clientSecret":"b"}');
  });

  test('posts the provider candidate and returns the verdict', async () => {
    const w = world(200, JSON.stringify({ ok: true }));
    const verdict = await createServerClient(w.fetch).oidc({
      issuer: 'https://idp.example.test',
      clientId: 'a',
      clientSecret: 'b',
      name: 'Acme SSO',
    });
    expect(verdict).toEqual({ ok: true });
    expect(w.seen[0]?.path).toBe('/api/server/oidc');
    expect(w.seen[0]?.init.method).toBe('POST');
  });

  test('posts the relay candidate and returns a refused verdict as it is', async () => {
    const refused: ProbeResult = { ok: false, reason: 'auth-failed', raw: '535' };
    const w = world(200, JSON.stringify(refused));
    const verdict = await createServerClient(w.fetch).smtp({
      smtpUrl: 'smtp://x',
      from: 'a@b.test',
      allowPlaintext: false,
    });
    expect(verdict).toEqual(refused);
    expect(w.seen[0]?.path).toBe('/api/server/smtp');
  });

  test('refuses a verdict that is not one', async () => {
    const failure = await failureOf(
      createServerClient(world(200, '{"ok":"maybe"}').fetch).github({
        clientId: 'a',
        clientSecret: 'b',
      }),
    );
    expect(failure.code).toBe('MALFORMED');
  });
});

describe('changing the settings', () => {
  test('disconnects with DELETE, and sends the strong confirmation only when it is the last way in', async () => {
    const w = world(204, '');
    const client = createServerClient(w.fetch);
    await client.disconnect('github', false);
    await client.disconnect('smtp', true);
    expect(w.seen.map((one) => [one.path, one.init.method, one.init.body])).toEqual([
      ['/api/server/github', 'DELETE', undefined],
      ['/api/server/smtp', 'DELETE', '{"confirmLastChannel":true}'],
    ]);
  });

  test('posts each rule of the policy on its own, and the workspace creators', async () => {
    const w = world(204, '');
    const client = createServerClient(w.fetch);
    await client.policy({ signUp: 'open' });
    await client.policy({ requireTwoFactor: true });
    await client.policy({ passwordSignIn: false });
    await client.creators({ kind: 'listed', logins: ['ada'] });
    expect(w.seen.map((one) => [one.path, one.init.body])).toEqual([
      ['/api/server/policy', '{"signUp":"open"}'],
      ['/api/server/policy', '{"requireTwoFactor":true}'],
      ['/api/server/policy', '{"passwordSignIn":false}'],
      ['/api/server/creators', '{"workspaceCreators":{"kind":"listed","logins":["ada"]}}'],
    ]);
  });

  test('hands a refusal’s reason to the caller', async () => {
    const body = JSON.stringify({
      error: { code: 'CONFLICT', message: 'no', details: { reason: 'last-channel' } },
    });
    const failure = await failureOf(
      createServerClient(world(409, body).fetch).disconnect('smtp', false),
    );
    expect(failure.status).toBe(409);
    expect(failure.reason).toBe('last-channel');
  });
});

describe('accounts (D-233)', () => {
  const ADA = {
    id: '00000000-0000-4000-8000-00000000a0a1',
    username: 'ada',
    displayName: 'Ada',
    email: null,
    isServerAdmin: false,
    suspendedAt: '2026-10-31T08:00:00.000Z',
  };

  test('finds by the words typed, escaped into the query, and nothing typed asks for everyone', async () => {
    const w = world(200, JSON.stringify([ADA]));
    const client = createServerClient(w.fetch);
    expect(await client.accounts('Ada L&')).toEqual([ADA]);
    await client.accounts('');
    expect(w.seen.map((one) => [one.path, one.init.method])).toEqual([
      ['/api/server/accounts?q=Ada%20L%26', 'GET'],
      ['/api/server/accounts', 'GET'],
    ]);
  });

  test('an answer that is not a list of accounts is a failure, never a half-read list', async () => {
    for (const body of ['{}', JSON.stringify([{ ...ADA, isServerAdmin: 'no' }])]) {
      expect(
        isSetupFailure(await failureOf(createServerClient(world(200, body).fetch).accounts(''))),
      ).toBe(true);
    }
  });

  test('suspends with PUT and lifts with DELETE, on the account’s own address', async () => {
    const w = world(204, '');
    const client = createServerClient(w.fetch);
    await client.suspend(ADA.id);
    await client.lift(ADA.id);
    expect(w.seen.map((one) => [one.path, one.init.method])).toEqual([
      [`/api/server/accounts/${ADA.id}/suspension`, 'PUT'],
      [`/api/server/accounts/${ADA.id}/suspension`, 'DELETE'],
    ]);
  });
});
