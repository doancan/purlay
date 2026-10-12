/**
 * Bearer secrets: a session's cookie (D-11) and an invitation's link (D-115).
 * One scheme, so two of them cannot differ in strength or in what they store.
 *
 * - **256 bits from the platform's generator**, hex-encoded — nothing to guess along, so looking one
 *   up by an indexed equality is not a timing oracle.
 * - **Only `SHA-256(token)` is stored**, hex: a copy of the database opens nothing.
 */

/** 32 bytes, as 64 hex digits. */
const TOKEN_BYTES = 32;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const randomToken = (): string => hex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));

/** What is stored, and what a presented token is looked up by. */
export const tokenDigest = async (token: string): Promise<string> =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
