/**
 * The two cookies this application sets. One definition of each name and its
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

export const stateCookie = (value: string): string =>
  `${STATE_COOKIE}=${value}; ${ATTRIBUTES}; Max-Age=600`;

export const clearedStateCookie = (): string => `${STATE_COOKIE}=; ${ATTRIBUTES}; Max-Age=0`;

export interface SessionCookie {
  readonly token: string;
  readonly expiresAt: Date;
}

/** The `Set-Cookie` value that stores a session. */
export const sessionCookie = ({ token, expiresAt }: SessionCookie): string =>
  `${SESSION_COOKIE}=${token}; ${ATTRIBUTES}; Expires=${expiresAt.toUTCString()}`;

/**
 * The `Set-Cookie` value that removes one.
 *
 * Every attribute except `Expires` has to match the cookie being replaced, or the
 * browser stores a second cookie beside the first and the session survives the
 * sign-out.
 */
export const clearedSessionCookie = (): string =>
  `${SESSION_COOKIE}=; ${ATTRIBUTES}; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;

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

/** Reads the session token out of a request's `Cookie` header, if it carries one. */
export const sessionTokenFrom = (cookieHeader: string | null): string | undefined =>
  readCookie(cookieHeader, SESSION_COOKIE);
