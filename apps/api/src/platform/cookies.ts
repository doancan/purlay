/**
 * The cookies this application sets. One definition of each name and its
 * attributes.
 *
 * These belong to ingress, not to the session module: `modules/` never sees an
 * HTTP concept, and lint enforces that line (`ARCHITECTURE.md` §4). The module
 * issues a token and an expiry; this decides how a browser is told to keep it.
 *
 * `HttpOnly` · `Secure` · `SameSite=Lax` (`ARCHITECTURE.md` §7.1):
 *
 * - **`HttpOnly`** — script cannot read it, so an injection cannot exfiltrate a
 *   session.
 * - **`Secure`** — never sent over plain HTTP. `localhost` is a secure context in
 *   every current browser, so development works; a self-hoster serving over plain
 *   HTTP on a LAN address cannot sign in, which is the intended answer rather
 *   than a bug. Configuration already refuses a non-`https` `APP_URL` in
 *   production.
 * - **`SameSite=Lax`** — sent on a top-level navigation, which the OAuth callback
 *   is, and withheld from cross-site sub-requests. `Strict` would break the
 *   callback; `None` would hand the cookie to any site that asks (D-39).
 * - **`Path=/`** — the socket upgrade is served from the same origin and needs it.
 * - **The `__Host-` prefix** — a browser accepts a cookie so named only if it is
 *   `Secure`, has `Path=/` and carries no `Domain`, so a sibling subdomain cannot
 *   plant one for this origin. Without it, a page on any subdomain could set the
 *   victim's session or OAuth state to the attacker's and sign them into the
 *   attacker's account (#199, D-62).
 */
export const SESSION_COOKIE = '__Host-purlay_session';

/**
 * The OAuth `state` cookie. `Path=/` because the prefix requires it, a ten-minute
 * `Max-Age` so an abandoned sign-in does not leave one behind, and consumed by
 * the callback whatever its outcome (D-62).
 */
export const STATE_COOKIE = '__Host-purlay_oauth_state';

const ATTRIBUTES = 'HttpOnly; Secure; SameSite=Lax; Path=/';

export const clearedStateCookie = (): string => `${STATE_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;

/**
 * Says a sign-in was sent round once already: a tab that lost a first sign-up to another tab of the
 * same person is sent back through GitHub, and a second loss with this cookie is a failure, never a
 * second round (D-78, R28). Ten minutes, as the state's; spent by the callback that finishes.
 */
export const RETRY_COOKIE = '__Host-purlay_signin_retry';

export const retryCookie = (): string => `${RETRY_COOKIE}=1; ${ATTRIBUTES}; Max-Age=600`;

export const clearedRetryCookie = (): string => `${RETRY_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;

/**
 * The invitation passport's cookie (D-179 §5, R51): what lets the one browser that asked for it make an
 * account on an invite-only server when it comes back from GitHub. `Lax`, not `Strict`, for the reason the
 * session's is — it must ride the top-level redirect back from github.com, which `Strict` withholds. The
 * value is a random secret, spent by the sign-up it was made for; the server keeps only its digest.
 */
export const INVITE_COOKIE = '__Host-purlay_invite';

/**
 * The second step of a password sign-in (D-236): the sign-in library's signed reference to the challenge a
 * right password opened, for ten minutes, spent by the right code. `__Host-` like the session's, so a sibling
 * subdomain cannot plant a challenge of its own.
 */
export const TWO_FACTOR_COOKIE = '__Host-purlay_two_factor';

export const inviteCookie = (value: string, maxAgeSeconds: number): string =>
  `${INVITE_COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=${String(maxAgeSeconds)}`;

/**
 * The setup's claim (D-179 §4.2): the token that binds the setup to the one browser that entered the
 * code. `SameSite=Strict`, unlike the session's — nothing reaches the setup by a link from another site,
 * so the cookie is never sent on one — and as long as the claim stays open unused (`SETUP_CLAIM_IDLE_MS`).
 * Cleared by the finish.
 */
export const SETUP_COOKIE = '__Host-purlay_setup';

const SETUP_ATTRIBUTES = 'HttpOnly; Secure; SameSite=Strict; Path=/';

export const setupCookie = (token: string, maxAgeSeconds: number): string =>
  `${SETUP_COOKIE}=${token}; ${SETUP_ATTRIBUTES}; Max-Age=${String(maxAgeSeconds)}`;

export const clearedSetupCookie = (): string => `${SETUP_COOKIE}=; ${SETUP_ATTRIBUTES}; Max-Age=0`;

/**
 * The `Set-Cookie` value that removes one.
 *
 * Every attribute except `Expires` has to match the cookie being replaced, or the
 * browser stores a second cookie beside the first and the session survives the
 * sign-out.
 */
export const clearedSessionCookie = (): string =>
  `${SESSION_COOKIE}=; ${ATTRIBUTES}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

/**
 * The session cookie as it is set on a client that is not a browser's own sign-in — the native
 * application's, once its code is spent (D-191). The same name and the same attributes as the library's:
 * a session made by either is the same kind of session, and the application keeps this value as the one
 * thing it holds. `maxAgeSeconds` is how long the session lasts, so the application knows when to ask again.
 */
export const sessionCookie = (value: string, maxAgeSeconds: number): string =>
  `${SESSION_COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=${String(maxAgeSeconds)}`;

/** One cookie's value out of a request's `Cookie` header, if it carries one. */
export const readCookie = (cookieHeader: string | null, name: string): string | undefined => {
  if (cookieHeader === null) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
};
