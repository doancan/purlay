/**
 * Bearer secrets: a session's cookie (D-11), an invitation's link (D-115) and the setup's code and
 * claim (D-179 §4).
 * One scheme, so two of them cannot differ in strength or in what they store.
 *
 * - **256 bits from the platform's generator**, hex-encoded — nothing to guess along, so looking one
 *   up by an indexed equality is not a timing oracle.
 * - **Only `SHA-256(token)` is stored**, hex: a copy of the database opens nothing.
 */
import { timingSafeEqual } from 'node:crypto';

/** 32 bytes, as 64 hex digits. */
const TOKEN_BYTES = 32;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const randomToken = (): string => hex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));

/** What is stored, and what a presented token is looked up by. */
export const tokenDigest = async (token: string): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));

/**
 * `count` symbols drawn evenly from `alphabet`, from the platform's generator: for a secret a person
 * types, where 64 hex digits would not be read aloud. The alphabet's size must divide 256, so one byte
 * picks one symbol with no symbol likelier than another.
 */
export const randomSymbols = (alphabet: string, count: number): string => {
  if (alphabet.length === 0 || 256 % alphabet.length !== 0) {
    throw new Error('an alphabet of random symbols must have a size that divides 256');
  }
  return Array.from(
    crypto.getRandomValues(new Uint8Array(count)),
    (byte) => alphabet[byte % alphabet.length],
  ).join('');
};

/**
 * Whether two digests are the same, in time that does not depend on where they differ: for a secret
 * compared with the one stored rather than looked up by it. Two `tokenDigest`s always have one length.
 */
export const digestsEqual = (presented: string, stored: string): boolean => {
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(stored, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
};
