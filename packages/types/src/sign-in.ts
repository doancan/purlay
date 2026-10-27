/**
 * How a sign-in that did not finish comes back to the sign-in screen (D-121).
 *
 * The callback is reached only by a browser that GitHub redirected, so it never
 * answers JSON: it sends the browser to the sign-in screen with one reason from
 * this closed set, and the screen says what happened and what to do. The address
 * carries the reason and nothing else — no error code, no message, nothing the
 * server or GitHub said — because a URL is copied, logged and kept in history.
 *
 * Both halves live here: the API writes the address and the client reads it, so
 * the parameter's name and the set of values cannot drift between them.
 */
import { Type, type Static } from '@sinclair/typebox';

/** The sign-in screen's address. The client's route table spells it from here. */
export const SIGN_IN_PATH = '/sign-in';

/** Where the sign-in library answers (D-179): every route of its own is under this path. */
export const AUTH_BASE_PATH = '/auth';

/**
 * Where GitHub sends the browser back to: the library's own callback under its base path, so the
 * address GitHub is given is `APP_URL` followed by this (D-61, D-179). Spelled once, here — the
 * library is configured with `AUTH_BASE_PATH`, and a failure on this path is answered as a redirect
 * to the sign-in screen rather than JSON, because only a browser ever arrives there (D-121).
 */
export const SIGN_IN_CALLBACK = `${AUTH_BASE_PATH}/callback/github`;

/**
 * Where the browser is sent to start a single sign-on and where the provider sends it back (D-200): the
 * start is a route of Purlay's, the callback the library's own under its base path, answered as a
 * redirect to the sign-in screen when it fails, exactly as GitHub's is (D-121).
 */
export const OIDC_START_PATH = '/auth/oidc';
export const OIDC_CALLBACK = `${AUTH_BASE_PATH}/callback/oidc`;

/** How long a sign-in link opens (D-138 §4): the server's expiry and every sentence that names it. */
export const SIGN_IN_LINK_TTL_MINUTES = 15;

/** The query parameter the reason travels in. */
const FAILURE_PARAM = 'error';

/**
 * Every reason a sign-in did not finish, as the person needs to hear it — not as
 * the server classified it. Several codes collapse into one reason where the
 * person's next step is the same.
 */
export const SignInFailure = Type.Union([
  /** They pressed Cancel on GitHub's screen (`error=access_denied`). */
  Type.Literal('cancelled'),
  /** The `state` check failed: no cookie, an expired one, or not the one this browser was given. */
  Type.Literal('expired'),
  /** The GitHub account has no primary verified address (D-38). */
  Type.Literal('email-required'),
  /**
   * A local account has this address but has not verified it, so GitHub is not linked to it
   * (`ACCOUNT_EMAIL_CONFLICT`, D-179 §5).
   */
  Type.Literal('email-taken'),
  /** A new account on a server whose sign-up is invite-only, with no invitation (D-179 §5). */
  Type.Literal('signup-closed'),
  /** GitHub could not be reached, refused, or answered something unusable. */
  Type.Literal('github-unavailable'),
  /**
   * The organisation's single sign-on could not be reached, refused, or answered something that is not
   * a valid identity: an id_token whose signature, issuer, audience, expiry or nonce is wrong (D-200).
   */
  Type.Literal('oidc-unavailable'),
  /** The single sign-on gave no address, or did not say it was verified: it is never linked on that (D-200 §3). */
  Type.Literal('email-unverified'),
  /** Too many sign-ins from here, or no database connection in time: wait, then retry. */
  Type.Literal('busy'),
  /** Anything else. The cause is in the server's log, never in the address. */
  Type.Literal('failed'),
]);
export type SignInFailure = Static<typeof SignInFailure>;

/**
 * The set, read off the schema rather than listed again. Not `Value.Check`: this
 * runs in the client, and the checker is a large module to load for one lookup.
 */
const FAILURES: ReadonlySet<string> = new Set(SignInFailure.anyOf.map((literal) => literal.const));

const isFailure = (value: string): value is SignInFailure => FAILURES.has(value);

/** Where the browser is sent when a sign-in did not finish. A path, so the API prefixes its own origin. */
export const signInFailureHref = (failure: SignInFailure): string =>
  `${SIGN_IN_PATH}?${new URLSearchParams({ [FAILURE_PARAM]: failure }).toString()}`;

/**
 * The reason an address carries, or null when it carries none. A value outside
 * the set — an old link, a hand-typed one — still says the sign-in failed, so
 * the screen reads it as `failed` rather than pretending nothing happened.
 */
export const signInFailureIn = (search: string): SignInFailure | null => {
  const value = new URLSearchParams(search).get(FAILURE_PARAM);
  if (value === null) return null;
  return isFailure(value) ? value : 'failed';
};
