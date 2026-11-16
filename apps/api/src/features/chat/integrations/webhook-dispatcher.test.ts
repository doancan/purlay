import http from 'node:http';
import { checkingLookup } from '../../../modules/images/fetch-external';
import { makeWebhookPost } from './webhook-dispatcher';
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { OutgoingWebhookRequest, WebhookPayload } from '@purlay/types';
import { webhookTarget } from './outgoing-webhooks';
import { nextWebhookAttempt, webhookSignature } from './webhook-dispatcher';

const now = new Date('2026-11-14T12:00:00.000Z');
describe('webhook boundaries', () => {
  for (const url of [
    'http://example.com',
    'https://localhost',
    'https://a.localhost',
    'https://10.0.0.1',
    'https://127.0.0.1',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://2130706433',
    'https://user:pass@example.com',
    'https://example.com/#secret',
    'https://example.com:8443',
    'not a url',
  ]) {
    test(`refuses destination ${url}`, () => {
      expect(() => webhookTarget(url)).toThrow();
    });
  }
  test('accepts public HTTPS and normalizes default ports', () => {
    expect(webhookTarget('https://example.com:443/hook?q=1').href).toBe(
      'https://example.com/hook?q=1',
    );
    expect(webhookTarget('https://8.8.8.8/hook').hostname).toBe('8.8.8.8');
  });
  test('signs timestamp and exact bytes with the documented HMAC convention', () => {
    const body = '{"text":"İstanbul 🐈"}';
    const expected = createHmac('sha256', 'secret')
      .update('1794657600.')
      .update(body)
      .digest('hex');
    expect(webhookSignature('secret', '1794657600', body)).toBe(`v1=${expected}`);
    expect(webhookSignature('secret', '1794657601', body)).not.toBe(`v1=${expected}`);
    expect(webhookSignature('secret', '1794657600', `${body}\n`)).not.toBe(`v1=${expected}`);
  });
  test('bounds exponential jitter, Retry-After seconds/date, invalid values and date overflow', () => {
    const at = (attempt: number, header?: string, random = 0.5): number =>
      nextWebhookAttempt(now, attempt, header, () => random).getTime() - now.getTime();
    expect(at(1)).toBe(5000);
    expect(at(2)).toBe(10000);
    expect(at(1, undefined, 0)).toBe(3750);
    expect(at(1, undefined, 1)).toBe(6250);
    expect(at(1, '60')).toBe(60_000);
    expect(at(1, 'Sat, 14 Nov 2026 12:01:00 GMT')).toBe(60_000);
    expect(at(1, 'not a date')).toBe(5000);
    expect(at(1, '-1')).toBe(5000);
    expect(at(1, '9'.repeat(48))).toBe(86_400_000);
    expect(Number.isFinite(at(1, '9'.repeat(400)))).toBe(true);
    expect(at(500)).toBeLessThanOrEqual(3_600_000);
  });
  test('validates nonempty unique event selection, bounded names and closed request shapes', () => {
    const valid = { name: 'CI 🐈', url: 'https://example.com', events: ['message.created'] };
    expect(Value.Check(OutgoingWebhookRequest, valid)).toBe(true);
    for (const bad of [
      { ...valid, events: [] },
      { ...valid, events: ['unknown'] },
      { ...valid, events: ['message.created', 'message.created'] },
      { ...valid, name: '' },
      { ...valid, name: 'a'.repeat(81) },
      { ...valid, url: 'a'.repeat(2049) },
      { ...valid, headers: { secret: 'x' } },
    ])
      expect(Value.Check(OutgoingWebhookRequest, bad)).toBe(false);
    expect(Value.Check(WebhookPayload, {})).toBe(false);
  });
});

test('the real outbound HTTP adapter records status and Retry-After, refuses redirects and times out', async () => {
  const server = http.createServer((request, response) => {
    if (request.url === '/slow') return;
    response.writeHead(request.url === '/redirect' ? 302 : 429, {
      'retry-after': '60',
      location: 'http://127.0.0.1/private',
    });
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const post = makeWebhookPost({
    transport: http,
    port: address.port,
    lookup: checkingLookup(
      () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
      () => true,
    ),
    timeoutMs: 100,
  });
  try {
    expect(
      await post(new URL('https://receiver.example/busy'), {}, new TextEncoder().encode('test')),
    ).toEqual({ status: 429, error: null, retryAfter: '60' });
    expect(
      (await post(new URL('https://receiver.example/redirect'), {}, new Uint8Array())).status,
    ).toBe(302);
    expect(await post(new URL('https://receiver.example/slow'), {}, new Uint8Array())).toEqual({
      status: null,
      error: 'network_error',
    });
    const blocked = makeWebhookPost({
      transport: http,
      port: address.port,
      lookup: checkingLookup(() => Promise.resolve([{ address: '127.0.0.1', family: 4 }])),
      timeoutMs: 100,
    });
    expect(
      await blocked(new URL('https://receiver.example/private'), {}, new Uint8Array()),
    ).toEqual({ status: null, error: 'network_error' });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }
});
