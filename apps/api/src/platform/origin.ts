/**
 * Whether a request came from this application's own origin.
 *
 * One home for the equality the socket upgrade (D-39 item 1) and the HTTP
 * edge (item 2) both rest on. `APP_URL` is already an origin — the loader
 * drops a trailing slash and refuses a path (#200) — and so is what a browser
 * sends, which makes this a string comparison and not a parse: a parse that
 * is lenient is a parse an attacker can aim at.
 *
 * An absent `Origin` (`null` here) and the opaque `Origin: null` a sandboxed
 * frame sends are both not the application's, and both answer `false`.
 */
export const isAppOrigin = (origin: string | null, appUrl: string): boolean => origin === appUrl;
