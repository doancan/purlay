/**
 * A browser and a push service of a test's own (RFC 8291): the server's VAPID keys, a subscription's key pair that reads what it
 * is sent as the browser would, and a service that answers a status and keeps what it was sent.
 */
import { createECDH } from 'node:crypto';
import type { PushPost } from '../modules/push/sender';
import type { VapidKeys } from '../modules/push/vapid';

export const KEYS: VapidKeys = ((): VapidKeys => {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  return {
    publicKey: pair.getPublicKey().toString('base64url'),
    privateKey: Buffer.from(pair.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString(
      'base64url',
    ),
    subject: 'mailto:ops@example.com',
  };
})();

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  secret: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']),
      length * 8,
    ),
  );

/** A browser: its key pair and secret, and what it does with a body it is sent (RFC 8291). */
export const aBrowser = async (): Promise<{
  readonly p256dh: string;
  readonly auth: string;
  readonly read: (body: Uint8Array) => Promise<unknown>;
}> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const own = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const secret = crypto.getRandomValues(new Uint8Array(16));
  return {
    p256dh: Buffer.from(own).toString('base64url'),
    auth: Buffer.from(secret).toString('base64url'),
    read: async (body): Promise<unknown> => {
      const salt = body.slice(0, 16);
      const length = body[20] ?? 0;
      const server = body.slice(21, 21 + length);
      const shared = new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: 'ECDH',
            public: await crypto.subtle.importKey(
              'raw',
              server,
              { name: 'ECDH', namedCurve: 'P-256' },
              false,
              [],
            ),
          },
          pair.privateKey,
          256,
        ),
      );
      const joined = new Uint8Array([...text('WebPush: info\0'), ...own, ...server]);
      const ikm = await hkdf(secret, shared, joined, 32);
      const key = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: nonce },
          await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']),
          body.slice(21 + length),
        ),
      );
      const payload: unknown = JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
      return payload;
    },
  };
};

export interface Sent {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** A push service answering `status`, keeping what it was sent. */
export const aPushService = (status = 201): { post: PushPost; sent: Sent[] } => {
  const sent: Sent[] = [];
  return {
    sent,
    post: (url, headers, body): Promise<{ kind: 'answered'; status: number }> => {
      sent.push({ url: url.href, headers, body });
      return Promise.resolve({ kind: 'answered', status });
    },
  };
};
