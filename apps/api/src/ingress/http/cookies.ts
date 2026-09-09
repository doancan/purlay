/**
 * The session cookie. One definition of its name and its attributes.
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
 */
export const SESSION_COOKIE = 'purlay_session';

export interface SessionCookie {
  readonly token: string;
  readonly expiresAt: Date;
}

/** The `Set-Cookie` value that stores a session. */
export const sessionCookie = ({ token, expiresAt }: SessionCookie): string =>
  [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Expires=${expiresAt.toUTCString()}`,
  ].join('; ');

/**
 * The `Set-Cookie` value that removes one.
 *
 * Every attribute except `Expires` has to match the cookie being replaced, or the
 * browser stores a second cookie beside the first and the session survives the
 * sign-out.
 */
export const clearedSessionCookie = (): string =>
  [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ');

/** Reads the session token out of a request's `Cookie` header, if it carries one. */
export const sessionTokenFrom = (cookieHeader: string | null): string | undefined => {
  if (cookieHeader === null) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
};
