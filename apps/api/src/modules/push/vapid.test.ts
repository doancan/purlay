/**
 * The VAPID header (RFC 8292), read back the way a push service reads it: the token's signature
 * verifies with the public key it names, and its claims say which service, until when, and who.
 */
import { describe, expect, test } from 'bun:test';
import { createECDH } from 'node:crypto';
import { vapidAuthorization, vapidSigningKey, type VapidKeys } from './vapid';

const aPair = (): VapidKeys => {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  return {
    publicKey: pair.getPublicKey().toString('base64url'),
    // Padded: ECDH drops a leading zero byte, about one key in two hundred.
    privateKey: Buffer.from(pair.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString(
      'base64url',
    ),
    subject: 'mailto:ops@example.com',
  };
};

const NOW = new Date('2026-10-13T12:00:00.000Z');

const decoded = (part: string | undefined): unknown =>
  JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'));

describe('the VAPID header', () => {
  test('carries a token the push service can verify with the key the browser subscribed with', async () => {
    const keys = aPair();
    const header = await vapidAuthorization(
      await vapidSigningKey(keys),
      keys,
      'https://fcm.googleapis.com/fcm/send/abc:def',
      NOW,
    );
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match?.[2]).toBe(keys.publicKey);
    const [head, claims, signature] = (match?.[1] ?? '').split('.');
    expect(decoded(head)).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(decoded(claims)).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: NOW.getTime() / 1000 + 12 * 60 * 60,
      sub: 'mailto:ops@example.com',
    });
    const signed = Buffer.from(signature ?? '', 'base64url');
    expect(signed).toHaveLength(64);
    const verifying = await crypto.subtle.importKey(
      'raw',
      Buffer.from(keys.publicKey, 'base64url'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifying,
        signed,
        new TextEncoder().encode(`${head ?? ''}.${claims ?? ''}`),
      ),
    ).toBe(true);
  });

  test('is signed by the private key only: another pair’s does not verify', async () => {
    const keys = aPair();
    const other = aPair();
    const header = await vapidAuthorization(
      await vapidSigningKey({ ...other, publicKey: other.publicKey }),
      keys,
      'https://push.example.com/x',
      NOW,
    );
    const [head, claims, signature] = (/^vapid t=([^,]+),/.exec(header)?.[1] ?? '').split('.');
    const verifying = await crypto.subtle.importKey(
      'raw',
      Buffer.from(keys.publicKey, 'base64url'),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        verifying,
        Buffer.from(signature ?? '', 'base64url'),
        new TextEncoder().encode(`${head ?? ''}.${claims ?? ''}`),
      ),
    ).toBe(false);
  });
});
