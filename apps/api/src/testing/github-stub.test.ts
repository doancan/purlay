/**
 * The GitHub stub refuses what GitHub refuses, or a sign-in that passes against it proves nothing:
 * a token for a code is given only with its PKCE verifier, and the stub served on a port answers as
 * the `fetch` double does.
 */
import { describe, expect, test } from 'bun:test';
import { aGitHubStub } from './github-stub';

const person = { id: 7, login: 'Octo', name: 'Octo Cat', email: 'octo@example.test' };
const verifier = 'v'.repeat(64);
const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url');

const authorizeUrl = (over: Record<string, string> = {}): string =>
  `https://github.com/login/oauth/authorize?${new URLSearchParams({
    client_id: 'client-id',
    redirect_uri: 'https://purlay.test/auth/callback/github',
    scope: 'read:user user:email',
    state: 'a-state',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...over,
  }).toString()}`;

const tokenBody = (code: string, over: Record<string, string> = {}): string =>
  JSON.stringify({
    client_id: 'client-id',
    client_secret: 'client-secret',
    code,
    redirect_uri: 'https://purlay.test/auth/callback/github',
    code_verifier: verifier,
    ...over,
  });

const exchange = async (
  stub: ReturnType<typeof aGitHubStub>,
  body: string,
): Promise<Record<string, unknown>> =>
  (await (
    await stub.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(1000),
    })
  ).json()) as Record<string, unknown>;

describe('the GitHub stub', () => {
  test('refuses an authorize request without PKCE, or without user:email', () => {
    const stub = aGitHubStub(person);
    expect(() => stub.authorize(authorizeUrl({ code_challenge_method: 'plain' }))).toThrow('S256');
    expect(() => stub.authorize(authorizeUrl({ code_challenge: '' }))).toThrow('code_challenge');
    expect(() => stub.authorize(authorizeUrl({ scope: 'read:user' }))).toThrow('user:email');
  });

  test('gives a token only for the verifier of the challenge, the right app and redirect, once', async () => {
    const stub = aGitHubStub(person);
    const { code } = stub.authorize(authorizeUrl());
    expect(await exchange(stub, tokenBody(code, { code_verifier: 'w'.repeat(64) }))).toMatchObject({
      error: 'bad_verification_code',
    });
    expect(await exchange(stub, tokenBody(code, { code_verifier: '' }))).toMatchObject({
      error: 'bad_verification_code',
    });
    expect(await exchange(stub, tokenBody(code, { client_secret: 'x' }))).toMatchObject({
      error: 'incorrect_client_credentials',
    });
    expect(
      await exchange(stub, tokenBody(code, { redirect_uri: 'https://elsewhere' })),
    ).toMatchObject({
      error: 'redirect_uri_mismatch',
    });
    const given = await exchange(stub, tokenBody(code));
    expect(typeof given['access_token']).toBe('string');
    // Spent.
    expect(await exchange(stub, tokenBody(code))).toMatchObject({ error: 'bad_verification_code' });
    expect(stub.refusals).toEqual([
      'bad_verification_code',
      'bad_verification_code',
      'incorrect_client_credentials',
      'redirect_uri_mismatch',
      'bad_verification_code',
    ]);
  });

  test('answers an app it does not know as github.com does — 404, Not Found — and records every code presented', async () => {
    const stub = aGitHubStub(person);
    const response = await stub.fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: tokenBody('a-code', { client_id: 'Iv1.unknown' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(1000),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not Found' });
    expect(await exchange(stub, tokenBody('never-issued'))).toMatchObject({
      error: 'bad_verification_code',
    });
    expect(stub.refusals).toEqual(['Not Found', 'bad_verification_code']);
    expect(stub.presentedCodes).toEqual(['a-code', 'never-issued']);
  });

  test('served on a port, sends the browser back with a code, and answers the token and the API', async () => {
    const stub = aGitHubStub(person);
    const served = stub.serve(0);
    try {
      const authorize = new URL(authorizeUrl());
      const back = await fetch(`${served.url}/login/oauth/authorize${authorize.search}`, {
        redirect: 'manual',
      });
      expect(back.status).toBe(302);
      const to = new URL(back.headers.get('location') ?? '');
      expect(to.searchParams.get('state')).toBe('a-state');
      const code = to.searchParams.get('code') ?? '';
      const token = (await (
        await fetch(`${served.url}/login/oauth/access_token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: tokenBody(code),
        })
      ).json()) as { access_token: string };
      const user = await fetch(`${served.url}/user`, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      expect(await user.json()).toMatchObject({ id: 7, login: 'Octo' });
      const emails = await fetch(`${served.url}/user/emails`, {
        headers: { authorization: `Bearer ${token.access_token}` },
      });
      expect(await emails.json()).toEqual([
        { email: 'octo@example.test', primary: true, verified: true },
      ]);
      expect((await fetch(`${served.url}/user`)).status).toBe(401);
    } finally {
      served.stop();
    }
  });

  test('a code lasts GitHub’s ten minutes, and no longer', async () => {
    let now = Date.parse('2026-10-21T10:00:00Z');
    const stub = aGitHubStub(person, {}, undefined, { now: () => now });
    const fresh = stub.authorize(authorizeUrl()).code;
    const stale = stub.authorize(authorizeUrl()).code;
    now += 10 * 60 * 1000 - 1;
    expect(typeof (await exchange(stub, tokenBody(fresh)))['access_token']).toBe('string');
    now += 2;
    expect(await exchange(stub, tokenBody(stale))).toMatchObject({
      error: 'bad_verification_code',
    });
  });

  test('served, it listens on the loopback address unless told otherwise', () => {
    const served = aGitHubStub(person).serve(0);
    try {
      expect(served.boundTo).toBe('127.0.0.1');
    } finally {
      served.stop();
    }
  });
});
