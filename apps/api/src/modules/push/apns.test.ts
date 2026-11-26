import { describe, expect, test } from 'bun:test';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { aSelfSignedCertificate } from '../../testing/certificate';
import { fixedClock, systemClock } from '../../platform/clock';
import { createApnsProvider } from './apns';

const time = new Date('2026-11-26T12:00:00Z');
const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
const credentials = {
  environment: 'sandbox',
  topic: 'com.purlay.ios',
  teamId: 'ABCD123456',
  keyId: 'ZYXW987654',
  signingKey: await exportPKCS8(privateKey),
} as const;
const input = {
  deviceToken: 'ABCDEF1234567890'.repeat(4),
  payload: { title: 'Purlay', body: 'A new message', url: '/w/demo', tag: 'channel:demo' },
  collapseId: 'one-delivery',
  expiresAt: new Date(time.getTime() + 7_200_000),
};

describe('Apple push provider', () => {
  test('uses HTTP/2 over TLS, with an ES256 provider token and the alert headers', async () => {
    const { cert, key } = aSelfSignedCertificate();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert, key },
      http2: true,
      http1: false,
      fetch: async (request): Promise<Response> => {
        expect(new URL(request.url).pathname).toBe(`/3/device/${input.deviceToken.toLowerCase()}`);
        expect(request.method).toBe('POST');
        expect(request.headers.get('apns-push-type')).toBe('alert');
        expect(request.headers.get('apns-topic')).toBe(credentials.topic);
        expect(request.headers.get('apns-collapse-id')).toBe(input.collapseId);
        expect(request.headers.get('apns-expiration')).toBe(
          String(input.expiresAt.getTime() / 1_000),
        );
        const auth = request.headers.get('authorization') ?? '';
        expect(auth.startsWith('bearer ')).toBe(true);
        expect(
          await jwtVerify(auth.slice(7), publicKey, { issuer: credentials.teamId }),
        ).toMatchObject({
          payload: { iss: credentials.teamId, iat: time.getTime() / 1_000 },
          protectedHeader: { kid: credentials.keyId, alg: 'ES256' },
        });
        expect(await request.json()).toEqual({
          aps: { alert: { title: 'Purlay', body: 'A new message' }, sound: 'default' },
          url: '/w/demo',
          tag: 'channel:demo',
        });
        return new Response(null);
      },
    });
    try {
      const push = await createApnsProvider(credentials, fixedClock(time), async (url, options) => {
        expect(url.origin).toBe('https://api.sandbox.push.apple.com');
        expect(options.redirect).toBe('manual');
        expect(options.proxy).toBe(false);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        return await fetch(new URL(url.pathname, server.url), { ...options, tls: { ca: cert } });
      });
      expect(await push(input)).toEqual({ kind: 'delivered', status: 200 });
    } finally {
      await server.stop(true);
    }
  });

  test('reuses the bearer for concurrent pushes and refreshes it after 45 minutes', async () => {
    let now = time;
    const seen: (string | null)[] = [];
    const push = await createApnsProvider(
      { ...credentials, environment: 'production' },
      { now: () => now },
      async (url, options) => {
        expect(url.origin).toBe('https://api.push.apple.com');
        const request = new Request(url.href, options);
        seen.push(request.headers.get('authorization'));
        expect(await request.json()).toEqual({
          aps: { alert: { title: 'Purlay', body: 'A new message' } },
          url: '/w/demo',
          tag: 'channel:demo',
        });
        return new Response(null);
      },
    );
    const silent = { ...input, payload: { ...input.payload, silent: true } };
    await Promise.all([push(silent), push(silent)]);
    now = new Date(time.getTime() + 44 * 60_000);
    await push(silent);
    now = new Date(time.getTime() + 45 * 60_000);
    await push(silent);
    expect(seen).toHaveLength(4);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toBe(seen[2]);
    expect(seen[0]).not.toBe(seen[3]);
  });

  test('distinguishes an invalidated device from request and transient provider failures', async () => {
    let answer = new Response(null, { status: 410 });
    const push = await createApnsProvider(credentials, fixedClock(time), () =>
      Promise.resolve(answer),
    );
    expect(await push(input)).toEqual({ kind: 'unregistered', status: 410 });
    answer = Response.json({ reason: 'Unregistered', timestamp: time.getTime() }, { status: 410 });
    expect(await push(input)).toEqual({
      kind: 'unregistered',
      status: 410,
      invalidatedAt: time.getTime(),
    });
    for (const body of [
      'not JSON',
      '{}',
      '{"timestamp":-1}',
      '{"timestamp":"old"}',
      'x'.repeat(1025),
    ]) {
      answer = new Response(body, { status: 410 });
      expect(await push(input)).toEqual({ kind: 'unregistered', status: 410 });
    }
    for (const status of [302, 400, 403, 404, 413]) {
      answer = new Response('{}', { status, headers: { location: 'https://example.test/' } });
      expect(await push(input)).toEqual({ kind: 'refused', status });
    }
    answer = new Response('{}', { status: 429, headers: { 'retry-after': '5' } });
    expect(await push(input)).toEqual({ kind: 'retry', status: 429, retryAfter: '5' });
    answer = new Response(null, { status: 503 });
    expect(await push(input)).toEqual({ kind: 'retry', status: 503 });
    const offline = await createApnsProvider(credentials, fixedClock(time), (url) =>
      Promise.reject(new Error(`failed to post ${url.href}`)),
    );
    expect(await offline(input)).toEqual({ kind: 'retry' });
  });

  test('rejects an invalid topic, identifier, or private key before delivery', async () => {
    const badTopic = await createApnsProvider(
      { ...credentials, topic: 'invalid\nheader' },
      systemClock,
    ).catch((error: unknown) => error);
    expect(badTopic).toMatchObject({ message: 'APNs requires a valid app topic' });
    const badKeyId = await createApnsProvider(
      { ...credentials, keyId: 'short' },
      systemClock,
    ).catch((error: unknown) => error);
    expect(badKeyId).toMatchObject({ message: 'APNs requires a ten-character team ID and key ID' });
    const badPrivateKey = await createApnsProvider(
      { ...credentials, signingKey: 'not a private key' },
      systemClock,
    ).catch((error: unknown) => error);
    expect(badPrivateKey).toBeInstanceOf(Error);
  });

  test('avoids the network for expired work and malformed or oversized requests', async () => {
    const push = await createApnsProvider(credentials, fixedClock(time), () => {
      throw new Error('reached the network');
    });
    expect(await push({ ...input, expiresAt: time })).toEqual({ kind: 'canceled' });
    expect(await push({ ...input, expiresAt: new Date(NaN) })).toEqual({ kind: 'canceled' });
    expect(await push({ ...input, deviceToken: 'bad/path' })).toEqual({ kind: 'refused' });
    expect(await push({ ...input, collapseId: 'a'.repeat(65) })).toEqual({ kind: 'refused' });
    expect(
      await push({ ...input, payload: { ...input.payload, body: 'ab🔔'.repeat(1_000) } }),
    ).toEqual({ kind: 'refused' });
  });
});
