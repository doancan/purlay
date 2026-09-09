/**
 * The OAuth `state` value, and the signed cookie that carries it.
 *
 * Without it the callback is a CSRF endpoint that signs a victim into the
 * attacker's account (`ARCHITECTURE.md` §7.1).
 *
 * **Why signed, and not merely compared.** Comparing the cookie to the query
 * parameter is sound only while nothing else can write a cookie for this origin.
 * A sibling subdomain can — *cookie tossing* — and an attacker who sets both
 * halves has produced a valid-looking handshake. A signature they cannot forge
 * closes that; an equality check does not. (D-62)
 *
 * The key is derived from `ENCRYPTION_KEY` with domain separation rather than
 * being a second secret an operator has to generate and rotate (D-62).
 */
import type { Clock } from '../../platform/clock';

/** Long enough that the sign-in survives a slow typist, short enough to be uninteresting. */
const LIFETIME_MS = 10 * 60 * 1000;

/**
 * Domain separation. A key used for two purposes is a key whose compromise in one
 * place is a compromise in the other.
 */
const PURPOSE = 'purlay:oauth-state:v1';

const signingKey = async (encryptionKey: string): Promise<CryptoKey> => {
  const root = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(encryptionKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const derived = await crypto.subtle.sign('HMAC', root, new TextEncoder().encode(PURPOSE));
  return await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
};

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

const sign = async (encryptionKey: string, payload: string): Promise<string> =>
  hex(
    await crypto.subtle.sign(
      'HMAC',
      await signingKey(encryptionKey),
      new TextEncoder().encode(payload),
    ),
  );

/**
 * Compares without leaking where two values first differ.
 *
 * An early return on the first differing byte lets an attacker recover a
 * signature one byte at a time by measuring the response.
 */
const equal = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i += 1) {
    difference |= (a.codePointAt(i) ?? 0) ^ (b.codePointAt(i) ?? 0);
  }
  return difference === 0;
};

export interface OAuthState {
  /** Goes in the redirect to GitHub, and comes back as a query parameter. */
  readonly state: string;
  /** Goes in the cookie. Carries the state, its expiry and the signature over both. */
  readonly cookieValue: string;
}

export const issueState = async (encryptionKey: string, clock: Clock): Promise<OAuthState> => {
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  const state = hex(random);
  const expiresAt = clock.now().getTime() + LIFETIME_MS;
  const payload = `${state}.${String(expiresAt)}`;
  return { state, cookieValue: `${payload}.${await sign(encryptionKey, payload)}` };
};

/**
 * True only if the cookie is intact, unexpired, and names the state that came
 * back from GitHub. Any other answer is `false` — there is nothing useful to tell
 * apart, and telling them apart would describe the check to whoever is probing it.
 */
export const verifyState = async (
  encryptionKey: string,
  clock: Clock,
  cookieValue: string | undefined,
  returned: string | undefined,
): Promise<boolean> => {
  if (cookieValue === undefined || returned === undefined) return false;
  const parts = cookieValue.split('.');
  if (parts.length !== 3) return false;
  const [state, expiresAt, signature] = parts as [string, string, string];

  const payload = `${state}.${expiresAt}`;
  if (!equal(signature, await sign(encryptionKey, payload))) return false;

  const deadline = Number(expiresAt);
  if (!Number.isFinite(deadline) || clock.now().getTime() > deadline) return false;

  return equal(state, returned);
};
