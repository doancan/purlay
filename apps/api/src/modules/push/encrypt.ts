/**
 * A push's body, encrypted for one browser (RFC 8291, `aes128gcm` of RFC 8188; #78, D-126).
 *
 * Only that browser can read it: the key comes from an ECDH between a key pair made for this one
 * message and the browser's `p256dh`, mixed with its `auth` secret. The push service carries bytes it
 * cannot open. One record, so the whole notice fits in it (`PushPayload` is bounded far below 4 KB).
 *
 * The fresh parts — the salt and the one-message key pair — are an argument, so the RFC's own example
 * (Appendix A) is the test; `freshParts` makes them for a real send. WebCrypto only
 * (`docs/spikes/web-push.md`).
 */

/** The browser's half, as its subscription gave it: base64url. */
export interface BrowserKeys {
  readonly p256dh: string;
  readonly auth: string;
}

/** What is made new for each message. */
export interface FreshParts {
  readonly salt: Uint8Array<ArrayBuffer>;
  /** An ECDH key pair on P-256, used for this message only. */
  readonly pair: CryptoKeyPair;
}

/** The record size the header announces: one record, and room to spare. */
const RECORD_SIZE = 4096;

const bytes = (base64url: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(Buffer.from(base64url, 'base64url'));

const joined = (...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  secret: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> => {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8),
  );
};

/** A salt and a key pair for one message. */
export const freshParts = async (): Promise<FreshParts> => ({
  salt: crypto.getRandomValues(new Uint8Array(16)),
  pair: await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]),
});

/** The body of the POST to the push service: the `aes128gcm` header, then the one record. */
export const encryptPush = async (
  browser: BrowserKeys,
  plaintext: Uint8Array<ArrayBuffer>,
  fresh: FreshParts,
): Promise<Uint8Array<ArrayBuffer>> => {
  const browserPoint = bytes(browser.p256dh);
  const browserKey = await crypto.subtle.importKey(
    'raw',
    browserPoint,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const ownPoint = new Uint8Array(await crypto.subtle.exportKey('raw', fresh.pair.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: browserKey },
      fresh.pair.privateKey,
      256,
    ),
  );
  const keyInfo = joined(text('WebPush: info\0'), browserPoint, ownPoint);
  const secret = await hkdf(bytes(browser.auth), shared, keyInfo, 32);
  const contentKey = await hkdf(fresh.salt, secret, text('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(fresh.salt, secret, text('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', contentKey, 'AES-GCM', false, ['encrypt']);
  // The last record's padding delimiter is 2 (RFC 8188 §2).
  const record = joined(plaintext, new Uint8Array([2]));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, record),
  );
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, RECORD_SIZE);
  return joined(fresh.salt, size, new Uint8Array([ownPoint.length]), ownPoint, sealed);
};
