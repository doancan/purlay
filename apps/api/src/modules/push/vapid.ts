/**
 * The server's signature on each push (RFC 8292, VAPID; #78, D-126): a short-lived ES256 token
 * naming the push service it is for, and the public key the browser subscribed with, so the service
 * knows the push comes from whoever the browser trusted.
 *
 * The private key is a raw scalar, which WebCrypto cannot import as such: it goes in as a JWK whose
 * `x` and `y` are cut from the public point (`docs/spikes/web-push.md`). The configuration has
 * already refused a pair that is not one (`platform/config.ts`).
 */

/** The keys and the contact the configuration holds (`VAPID_*`). */
export interface VapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
  /** `mailto:` or `https:` — who the push service writes to about this server. */
  readonly subject: string;
}

/** Twelve hours: the services refuse a token good for more than a day (RFC 8292 §2). */
const LIFETIME_SECONDS = 12 * 60 * 60;

const base64url = (value: string | ArrayBuffer): string =>
  Buffer.from(typeof value === 'string' ? new TextEncoder().encode(value) : value).toString(
    'base64url',
  );

/** The private key, as a signing key. Imported once, when the sender is made. */
export const vapidSigningKey = async (keys: VapidKeys): Promise<CryptoKey> => {
  const point = Buffer.from(keys.publicKey, 'base64url');
  return await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
    },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
};

/** The `Authorization` header for one push to `endpoint`, signed at `now`. */
export const vapidAuthorization = async (
  signingKey: CryptoKey,
  keys: VapidKeys,
  endpoint: string,
  now: Date,
): Promise<string> => {
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = base64url(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now.getTime() / 1000) + LIFETIME_SECONDS,
      sub: keys.subject,
    }),
  );
  // WebCrypto's ECDSA signature is r ‖ s, 64 bytes: what JWS's ES256 is (RFC 7518 §3.4).
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `vapid t=${header}.${claims}.${base64url(signature)}, k=${keys.publicKey}`;
};
