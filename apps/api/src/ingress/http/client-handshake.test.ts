/**
 * What a native client learns before it signs in, and what it is told when it can no longer be served
 * (`API.md` §2, `GET /api/client`; the `426` row of §1).
 *
 * Driven through real requests against the real router with a database that throws on any access, so a
 * pass is also proof that none of this touches one.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { unconnectedDatabase } from '@purlay/db';
import { CONTRACT_VERSION, ClientInfo, ErrorResponse } from '@purlay/types';
import { createApp } from './app';
import { testConfig, testDependencies } from '../../testing/doubles';
import type { Config } from '../../platform/config';

const server = (
  overrides: Partial<Config> = {},
): ((path: string, init?: RequestInit) => Promise<Response>) => {
  const app = createApp(
    testDependencies({ database: unconnectedDatabase(), config: testConfig(overrides) }),
  );
  return async (path, init) => await app.handle(new Request(`https://purlay.test${path}`, init));
};

const withClient = (header: string): RequestInit => ({ headers: { 'x-purlay-client': header } });

describe('GET /api/client', () => {
  test('answers a stranger: no session, no database', async () => {
    const response = await server()('/api/client');
    expect(response.status).toBe(200);
    expect(Value.Check(ClientInfo, await response.json())).toBe(true);
  });

  test('advertises additive API support publicly even to a client below the configured minimum', async () => {
    for (const init of [
      undefined,
      withClient('macos/0.0.1 contract/0'),
      { headers: { cookie: 'unrelated=invalid' } },
    ]) {
      const response = await server({ MIN_CLIENT_MACOS_CONTRACT: 2 })('/api/client', init);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(Value.Check(ClientInfo, body)).toBe(true);
      expect(body).toMatchObject({
        capabilities: { notificationTypeFilters: true, scheduledMessages: true },
        contractVersion: CONTRACT_VERSION,
      });
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('the new schema accepts old handshakes and unknown capabilities; old response readers accept the addition', async () => {
    const body = (await (await server()('/api/client')).json()) as ClientInfo;
    const legacy = { ...body };
    delete legacy.capabilities;
    expect(Value.Check(ClientInfo, legacy)).toBe(true);
    expect(Value.Check(Type.Omit(ClientInfo, ['capabilities']), body)).toBe(true);
    for (const capabilities of [
      {},
      { notificationTypeFilters: false },
      { futureFeature: true },
      { futureFeature: { version: 2 } },
    ]) {
      expect(Value.Check(ClientInfo, { ...legacy, capabilities })).toBe(true);
    }
    for (const capabilities of [
      null,
      [],
      'enabled',
      { notificationTypeFilters: 'true' },
      { notificationTypeFilters: 1 },
    ]) {
      expect(Value.Check(ClientInfo, { ...legacy, capabilities })).toBe(false);
    }
  });

  test('says which server this is, which contract it speaks and the address it answers to', async () => {
    const body = (await (
      await server({ APP_URL: 'https://chat.example.test' })('/api/client')
    ).json()) as ClientInfo;
    expect(body.contractVersion).toBe(CONTRACT_VERSION);
    expect(body.appUrl).toBe('https://chat.example.test');
    expect(body.server.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('carries the sign-in methods, so one call is enough to draw the sign-in screen', async () => {
    const body = (await (await server()('/api/client')).json()) as ClientInfo;
    expect(body.auth).toEqual({ github: true, email: false, oidc: null, signUp: 'invite-only' });
  });

  test('says there is no minimum where none is set', async () => {
    const body = (await (await server()('/api/client')).json()) as ClientInfo;
    expect(body.minClient.macos).toEqual({
      contractVersion: null,
      appVersion: null,
      downloadUrl: null,
    });
  });

  test('says the minimum the operator set', async () => {
    const body = (await (
      await server({
        MIN_CLIENT_MACOS_CONTRACT: 1,
        MIN_CLIENT_MACOS_VERSION: '0.2.0',
        MACOS_DOWNLOAD_URL: 'https://example.test/purlay',
      })('/api/client')
    ).json()) as ClientInfo;
    expect(body.minClient.macos).toEqual({
      contractVersion: 1,
      appVersion: '0.2.0',
      downloadUrl: 'https://example.test/purlay',
    });
  });

  test('is answered to a client that is too old: it is how that client learns to update', async () => {
    const response = await server({ MIN_CLIENT_MACOS_CONTRACT: 1 })(
      '/api/client',
      withClient('macos/0.0.1 contract/0'),
    );
    expect(response.status).toBe(200);
  });

  test('is never cached, as nothing else here is', async () => {
    const response = await server()('/api/client');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('a client that is too old', () => {
  const tooOld = { MIN_CLIENT_MACOS_CONTRACT: 2 } satisfies Partial<Config>;
  const old = withClient('macos/1.0.0 contract/1');

  test('is refused with 426 and a body it can act on, before any session is looked at', async () => {
    const response = await server({
      ...tooOld,
      MIN_CLIENT_MACOS_VERSION: '1.1.0',
      MACOS_DOWNLOAD_URL: 'https://example.test/purlay',
    })('/api/me', old);
    expect(response.status).toBe(426);
    const body: unknown = await response.json();
    expect(Value.Check(ErrorResponse, body)).toBe(true);
    expect(body).toMatchObject({
      error: {
        code: 'CLIENT_TOO_OLD',
        details: {
          minContractVersion: 2,
          minAppVersion: '1.1.0',
          downloadUrl: 'https://example.test/purlay',
        },
      },
    });
  });

  test('is told, as 426 must, what to upgrade to', async () => {
    const response = await server(tooOld)('/api/me', old);
    expect(response.headers.get('upgrade')).toBe('purlay-client');
  });

  test('is refused on a write too, and the body is never read', async () => {
    const response = await server(tooOld)('/api/workspaces', {
      method: 'POST',
      headers: { 'x-purlay-client': 'macos/1.0.0 contract/1', 'content-type': 'application/json' },
      body: '{',
    });
    expect(response.status).toBe(426);
  });

  test('is refused at the socket upgrade, as a status and not as a socket that closes', async () => {
    const response = await server(tooOld)('/ws', {
      headers: {
        'x-purlay-client': 'macos/1.0.0 contract/1',
        upgrade: 'websocket',
        origin: 'https://purlay.test',
      },
    });
    expect(response.status).toBe(426);
  });

  test('can still be asked whether the server is alive', async () => {
    expect((await server(tooOld)('/health', old)).status).toBe(200);
  });

  // The router answers `/api/client/` with the same handler, so the exemption must too — or a client
  // that spells it so is refused on the one road it has to learn to update by.
  test('can ask what this server wants however the path is spelled', async () => {
    for (const path of ['/api/client/', '//api//client', '/health/', '/health/ready/']) {
      expect((await server(tooOld)(path, old)).status).not.toBe(426);
    }
  });

  test('is refused on the other roads however they are spelled', async () => {
    for (const path of ['/api/me/', '//api//me', '/api/clients']) {
      expect((await server(tooOld)(path, old)).status).toBe(426);
    }
  });

  test('is not refused by a minimum it meets', async () => {
    const response = await server(tooOld)('/api/me', withClient('macos/1.0.0 contract/2'));
    // Past the client check, to the next thing that stops a stranger.
    expect(response.status).toBe(401);
  });

  test('is refused by the version alone, when only a version is set', async () => {
    const response = await server({ MIN_CLIENT_MACOS_VERSION: '2.0.0' })(
      '/api/me',
      withClient('macos/1.9.9 contract/9'),
    );
    expect(response.status).toBe(426);
  });
});

describe('everybody else', () => {
  const strict = { MIN_CLIENT_MACOS_CONTRACT: 99 } satisfies Partial<Config>;

  test('a browser sends no header and is never refused', async () => {
    expect((await server(strict)('/api/me')).status).toBe(401);
  });

  test('a header that is not the shape is no client, so a typo never locks anyone out', async () => {
    for (const value of [
      'macos',
      'macos/1.0.0',
      'macos/x contract/1',
      'macos/1.0.0 contract/x',
      'x'.repeat(500),
    ]) {
      expect((await server(strict)('/api/me', withClient(value))).status).toBe(401);
    }
  });

  test('a platform nobody set a minimum for is not refused', async () => {
    expect((await server(strict)('/api/me', withClient('linux/0.0.1 contract/1'))).status).toBe(
      401,
    );
  });
});
