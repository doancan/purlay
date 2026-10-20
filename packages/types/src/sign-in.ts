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
  /** The GitHub account has no primary verified address (`EMAIL_REQUIRED`, D-38). */
  Type.Literal('email-required'),
  /** The address already belongs to another Purlay account (`ACCOUNT_EMAIL_CONFLICT`, D-38). */
  Type.Literal('email-taken'),
  /** GitHub could not be reached, refused, or answered something unusable. */
  Type.Literal('github-unavailable'),
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

/**
 * How connecting GitHub to a signed-in account came out (D-176), said on the settings page it started
 * from — a closed set in the address, as a sign-in's failure is, and for the same reasons.
 */
export const ConnectGitHubOutcome = Type.Union([
  /** Connected: the account now signs in with this GitHub account as well. */
  Type.Literal('connected'),
  /** They pressed Cancel on GitHub's screen. */
  Type.Literal('cancelled'),
  /** The `state` check failed: expired, or not the one this browser was given. */
  Type.Literal('expired'),
  /** The session that started it is not the one signed in here now: signed out, or another person. */
  Type.Literal('session'),
  /** That GitHub account is another Purlay account's already (`GITHUB_ACCOUNT_TAKEN`). Never merged. */
  Type.Literal('taken'),
  /** This account has a GitHub account already (`GITHUB_ALREADY_CONNECTED`). */
  Type.Literal('already'),
  /** GitHub could not be reached, refused, or answered something unusable. */
  Type.Literal('github-unavailable'),
  /** Too many requests from here, or no database connection in time: wait, then retry. */
  Type.Literal('busy'),
  /** Anything else. The cause is in the server's log, never in the address. */
  Type.Literal('failed'),
]);
export type ConnectGitHubOutcome = Static<typeof ConnectGitHubOutcome>;

/** The query parameter the outcome travels in, on the Sessions & account page. */
const CONNECT_PARAM = 'github';

const OUTCOMES: ReadonlySet<string> = new Set(
  ConnectGitHubOutcome.anyOf.map((literal) => literal.const),
);

const isOutcome = (value: string): value is ConnectGitHubOutcome => OUTCOMES.has(value);

/**
 * Where the browser is sent once a connect is over: that workspace's Sessions & account page. A path,
 * so the API prefixes its own origin; the slug is `[a-z0-9-]`, so it is a path and nothing else.
 */
export const connectGitHubHref = (workspace: string, outcome: ConnectGitHubOutcome): string =>
  `/w/${encodeURIComponent(workspace)}/settings/account?${new URLSearchParams({ [CONNECT_PARAM]: outcome }).toString()}`;

/** The outcome an address carries, or null; a value outside the set reads as `failed`. */
export const connectGitHubOutcomeIn = (search: string): ConnectGitHubOutcome | null => {
  const value = new URLSearchParams(search).get(CONNECT_PARAM);
  if (value === null) return null;
  return isOutcome(value) ? value : 'failed';
};
