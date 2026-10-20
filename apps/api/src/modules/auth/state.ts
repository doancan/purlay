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

/**
 * Connecting GitHub to a signed-in account (D-176) signs under a key of its own, so a sign-in's
 * cookie can never be read as a connect's, nor a connect's as a sign-in's, whatever its shape.
 */
const CONNECT_PURPOSE = 'purlay:oauth-connect-state:v1';

const signingKey = async (encryptionKey: string, purpose = PURPOSE): Promise<CryptoKey> => {
  const root = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(encryptionKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const derived = await crypto.subtle.sign('HMAC', root, new TextEncoder().encode(purpose));
  return await crypto.subtle.importKey('raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
};

const hex = (bytes: ArrayBuffer | Uint8Array): string =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

const sign = async (encryptionKey: string, payload: string, purpose = PURPOSE): Promise<string> =>
  hex(
    await crypto.subtle.sign(
      'HMAC',
      await signingKey(encryptionKey, purpose),
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

const randomState = (): string => {
  const random = new Uint8Array(16);
  crypto.getRandomValues(random);
  return hex(random);
};

export const issueState = async (encryptionKey: string, clock: Clock): Promise<OAuthState> => {
  const state = randomState();
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

/**
 * Connecting GitHub to the account a session is signed in as (D-176): who asked, from which session,
 * and which workspace's settings page to come back to. Signed with the rest, so none of it can be
 * changed on the way — the callback trusts it only as far as the session still signed in agrees.
 */
export interface ConnectIntent {
  readonly userId: string;
  readonly sessionId: string;
  /** A workspace slug: `[a-z0-9-]`, so the page is a path on this origin and nowhere else. */
  readonly workspace: string;
}

const CONNECT_TAG = 'connect';
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const issueConnectState = async (
  encryptionKey: string,
  clock: Clock,
  intent: ConnectIntent,
): Promise<OAuthState> => {
  if (!UUID.test(intent.userId) || !UUID.test(intent.sessionId) || !SLUG.test(intent.workspace)) {
    // Nothing a caller types reaches here unchecked; a value that would break the cookie's shape is
    // this server's defect, said loudly rather than signed.
    throw new Error('a connect intent must name a user, a session and a workspace slug');
  }
  const state = randomState();
  const expiresAt = clock.now().getTime() + LIFETIME_MS;
  const payload = [
    CONNECT_TAG,
    state,
    String(expiresAt),
    intent.userId,
    intent.sessionId,
    intent.workspace,
  ].join('.');
  return {
    state,
    cookieValue: `${payload}.${await sign(encryptionKey, payload, CONNECT_PURPOSE)}`,
  };
};

interface SignedConnect {
  readonly state: string;
  readonly expiresAt: string;
  readonly intent: ConnectIntent;
}

const signedConnect = async (
  encryptionKey: string,
  cookieValue: string | undefined,
): Promise<SignedConnect | undefined> => {
  if (cookieValue === undefined) return undefined;
  const parts = cookieValue.split('.');
  if (parts.length !== 7 || parts[0] !== CONNECT_TAG) return undefined;
  const [, state, expiresAt, userId, sessionId, workspace, signature] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const payload = parts.slice(0, 6).join('.');
  if (!equal(signature, await sign(encryptionKey, payload, CONNECT_PURPOSE))) return undefined;
  return { state, expiresAt, intent: { userId, sessionId, workspace } };
};

/**
 * Whether this browser's cookie is a connect this server signed — expired or not, matched or not.
 * Only where to send the person back turns on it: a connect that failed is told on the settings page
 * it started from, and anything this server did not sign is a sign-in's failure, as before.
 */
export const connectIntentOf = async (
  encryptionKey: string,
  cookieValue: string | undefined,
): Promise<ConnectIntent | undefined> => (await signedConnect(encryptionKey, cookieValue))?.intent;

/**
 * The connect this browser started, when the cookie is intact, unexpired and names the state that
 * came back from GitHub; otherwise nothing, for the same reason `verifyState` tells nothing apart.
 */
export const verifyConnectState = async (
  encryptionKey: string,
  clock: Clock,
  cookieValue: string | undefined,
  returned: string | undefined,
): Promise<ConnectIntent | undefined> => {
  const signed = await signedConnect(encryptionKey, cookieValue);
  if (signed === undefined || returned === undefined) return undefined;
  const deadline = Number(signed.expiresAt);
  if (!Number.isFinite(deadline) || clock.now().getTime() > deadline) return undefined;
  return equal(signed.state, returned) ? signed.intent : undefined;
};
