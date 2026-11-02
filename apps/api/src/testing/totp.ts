/**
 * An authenticator app for tests (D-236): the code RFC 6238 makes from the key in an `otpauth://` link, worked
 * out here from the RFC with `node:crypto` — not by the library under test — so a test that passes means the
 * library agrees with an app, not with itself.
 */
import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_MS = 30_000;
const DIGITS = 6;

/** The key an `otpauth://totp/…?secret=<base32>` link carries, as bytes. */
export const keyOf = (totpURI: string): Buffer => {
  const encoded = new URL(totpURI).searchParams.get('secret') ?? '';
  let bits = '';
  for (const letter of encoded.toUpperCase()) {
    const value = BASE32.indexOf(letter);
    if (value < 0) throw new Error(`not base32: ${letter}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => parseInt(byte, 2)));
};

/** The code an app shows for `key` at `at` (milliseconds since the epoch), `steps` periods on. */
export const codeAt = (key: Buffer, at: number, steps = 0): string => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / PERIOD_MS) + steps));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const value = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 10 ** DIGITS).padStart(DIGITS, '0');
};

/** A code that is none of those an app would accept now (the period before, this one, the next). */
export const aWrongCode = (key: Buffer, at: number): string => {
  const accepted = new Set([-1, 0, 1].map((steps) => codeAt(key, at, steps)));
  for (let candidate = 0; ; candidate += 1) {
    const code = String(candidate).padStart(DIGITS, '0');
    if (!accepted.has(code)) return code;
  }
};
