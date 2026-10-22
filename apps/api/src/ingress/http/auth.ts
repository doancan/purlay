/**
 * Sign-in, as functions rather than as routes.
 *
 * Each one takes a request and returns what the response should be. Nothing here
 * knows which framework serves it, which means the whole handshake — including
 * every way it can be refused — is testable without a server, and the routing
 * stays in one file (`app.ts`).
 *
 * It also sidesteps a real constraint rather than fighting it: an application's
 * type is invariant in its routes, so a route group cannot be returned or passed
 * as a bare application, and the library's permissive alias launders `any` into
 * every handler (`docs/spikes/elysia.md`).
 *
 * They read the request, call what decides — the sign-in library (D-179), or a module
 * of ours (`modules/auth/sign-in.ts`) — and turn its outcome into
 * cookies and a redirect, nothing else. The way home
 * is `APP_URL` itself (D-61), and the way back from a sign-in that did not finish
 * is the sign-in screen with a reason from a closed set (D-121).
 */
import { CLIENT_ADDRESS_HEADER, type Auth, type AuthAnswer } from '../../modules/auth/better-auth';
import { EraseAccountRequest, type MySignIn } from '@purlay/types';
import { mySignIn } from '../../modules/auth/my-sign-in';
import { eraseAccount } from '../../modules/users/erasure';
import {
  publication,
  publishAfterCommit,
  publishUserDeleted,
  publishWorkspaceUpdated,
} from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { validated } from './validate';
import { AppError } from '../../platform/errors';
import type { Executor } from '@purlay/db';
import {
  AUTH_BASE_PATH,
  SIGN_IN_CALLBACK,
  SIGN_IN_PATH,
  signInFailureHref,
  type ErrorCode,
  type SignInFailure,
} from '@purlay/types';
import type { Config } from '../../platform/config';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import type { EventBus } from '../../platform/events';
import {
  signOut as signOutOf,
  signOutEverywhere as signOutEverywhereOf,
} from '../../modules/auth/sign-in';
import { requireSession } from './session';
import { sessionFromHeaders } from '../../modules/auth/sessions';
import {
  clearedRetryCookie,
  clearedSessionCookie,
  clearedStateCookie,
  RETRY_COOKIE,
  retryCookie,
  readCookie,
} from '../../platform/cookies';

export interface AuthDependencies {
  /** Who is calling: every session is resolved through it (`sessions.ts`, D-179). */
  readonly auth: Auth;
  readonly config: Config;
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
}

/** Signing out also reaches the sockets the revoked sessions hold. */
export interface SignOutDependencies extends AuthDependencies {
  readonly bus: EventBus;
}

/** What a handler decided. `location` set means a redirect; otherwise `204`. */
export interface AuthResponse {
  /** Each a separate `Set-Cookie` header. */
  readonly setCookie: readonly string[];
  readonly location?: string;
}

/** The library's route that starts a social sign-in: what `/auth/github` calls, and a client may too. */
const SOCIAL_SIGN_IN = `${AUTH_BASE_PATH}/sign-in/social`;

/** What a start of a GitHub sign-in is answered where no GitHub app is connected (`API.md`). */
const notSetUp = (): AppError =>
  new AppError({
    code: 'ROUTE_NOT_FOUND',
    message: 'GitHub sign-in is not set up on this server.',
  });

/**
 * `GET /auth/github` — the sign-in screen's button, a full-page navigation: the library makes the
 * state (its row and its `__Host-` cookie) and GitHub's address, and the browser is sent there. The
 * way back is the library's callback (`SIGN_IN_CALLBACK`); home on success, the sign-in screen with a
 * reason otherwise (D-121). With no GitHub app connected it is `404 ROUTE_NOT_FOUND`, the route not
 * existing yet (`API.md`).
 */
export const startSignIn = async ({
  auth,
  config,
}: Pick<AuthDependencies, 'auth' | 'config'>): Promise<AuthResponse> => {
  // A server whose GitHub app is not connected yet (setup mode, D-179 §4) has no such route: the
  // library throws for a provider it does not have, and a person is never sent to GitHub with no app.
  // The sign-in screen does not offer the button then (`AuthMethods.github`), so this is a stale link
  // or a typed address: the API's own 404.
  if (!auth.github) throw notSetUp();
  const { headers, response } = await auth.api.signInSocial({
    body: {
      provider: 'github',
      callbackURL: config.APP_URL,
      errorCallbackURL: `${config.APP_URL}${SIGN_IN_PATH}`,
    },
    returnHeaders: true,
  });
  if (response.url === undefined) {
    throw new Error('the sign-in library gave no address to send the browser to');
  }
  return { setCookie: headers.getSetCookie(), location: response.url };
};

/**
 * GitHub's word for *the person pressed Cancel* (RFC 6749 §4.1.2.1). Any other
 * `error` it sends back is a misconfiguration of the OAuth app, not the person's
 * doing.
 */
const DECLINED = 'access_denied';

/** The longest piece of GitHub's `error` the log keeps: it arrived in a URL anyone can write. */
const LOGGED_ERROR_LENGTH = 64;

/** The answer to a sign-in that did not finish: the state spent, and the sign-in screen with why. */
const sentBack = (config: Pick<Config, 'APP_URL'>, failure: SignInFailure): AuthResponse => ({
  setCookie: [clearedStateCookie()],
  location: `${config.APP_URL}${signInFailureHref(failure)}`,
});

/**
 * The codes the callback can meet that the person can act on. Partial on purpose: any
 * other code reaching the callback is this server's surprise, and the person can only
 * retry — `failed`.
 */
const FAILURE_FOR_CODE: Readonly<Partial<Record<ErrorCode, SignInFailure>>> = {
  ACCOUNT_EMAIL_CONFLICT: 'email-taken',
  RATE_LIMITED: 'busy',
  DATABASE_UNAVAILABLE: 'busy',
};

/** What the person is told, from the code the one mapping every refusal goes through (`refusalFor`) gave. */
const failureFor = (code: ErrorCode): SignInFailure => FAILURE_FOR_CODE[code] ?? 'failed';

/**
 * The callback's answer to anything thrown while serving it, the rate limit
 * included. Never JSON: only a browser GitHub redirected ever arrives here, and a
 * JSON body would be the last thing the person sees (D-121).
 *
 * What the person is not told is written down instead — loudly for the
 * unexpected, as every other `INTERNAL` is.
 */
export const abandonSignIn = (
  { config, log }: Pick<AuthDependencies, 'config' | 'log'>,
  error: unknown,
  code: ErrorCode,
): AuthResponse => {
  const failure = failureFor(code);
  if (code === 'INTERNAL') log.error('request failed', { err: error, path: SIGN_IN_CALLBACK });
  return sentBack(config, failure);
};

/**
 * Why the library sent a callback back, in its words, and what the person is told (D-121). Its
 * reasons are URL codes (`?error=`), not ours: each one the callback can produce is here, so a new
 * one is a decision, and anything else — a code this table has not met — is `failed`, never the
 * library's own string in the address. `level` is how loudly the server's log says it.
 */
const FAILURE_FOR_LIBRARY_CODE: Readonly<
  Record<string, { readonly failure: SignInFailure; readonly level: 'info' | 'warn' | 'error' }>
> = {
  // The state check, every way it fails, is one reason (D-62, D-121 §3); a callback with no code
  // is one too, as it always was.
  state_not_found: { failure: 'expired', level: 'info' },
  state_mismatch: { failure: 'expired', level: 'info' },
  state_invalid: { failure: 'expired', level: 'info' },
  state_security_mismatch: { failure: 'expired', level: 'info' },
  please_restart_the_process: { failure: 'expired', level: 'info' },
  no_code: { failure: 'expired', level: 'info' },
  // GitHub did not take the code: unreachable, refusing, or the code spent (`exchangeCode`).
  invalid_code: { failure: 'github-unavailable', level: 'warn' },
  // No primary verified address (the provider's call answered nothing, D-38).
  unable_to_get_user_info: { failure: 'email-required', level: 'info' },
  email_not_found: { failure: 'email-required', level: 'info' },
  email_not_verified: { failure: 'email-required', level: 'info' },
  // The address is another account's, and neither side may be linked (D-179 §5): what
  // `ACCOUNT_EMAIL_CONFLICT` always meant.
  account_not_linked: { failure: 'email-taken', level: 'info' },
  // A new account on a server whose sign-up is invite-only (D-179 §5).
  signup_disabled: { failure: 'signup-closed', level: 'info' },
  unable_to_link_account: { failure: 'failed', level: 'error' },
  unable_to_create_user: { failure: 'failed', level: 'error' },
  unable_to_create_session: { failure: 'failed', level: 'error' },
  internal_server_error: { failure: 'failed', level: 'error' },
};

/** What the person is told for a reason the library gave, and the line the log keeps of it. */
const failureForLibraryCode = (log: Logger, code: string): SignInFailure => {
  // Own keys only: `constructor` is no reason of the library's.
  const known = Object.hasOwn(FAILURE_FOR_LIBRARY_CODE, code)
    ? FAILURE_FOR_LIBRARY_CODE[code]
    : undefined;
  // It arrived in a URL anybody can write; the log keeps a bounded piece of it.
  const said = { libraryError: code.slice(0, LOGGED_ERROR_LENGTH) };
  if (known === undefined) {
    log.error('a GitHub sign-in failed for a reason nobody anticipated', said);
    return 'failed';
  }
  log[known.level]('a GitHub sign-in did not finish', { ...said, failure: known.failure });
  return known.failure;
};

/** A failure answered by status, where the library answered something other than a redirect. */
const failureForStatus = (log: Logger, status: number): SignInFailure => {
  if (status === 429 || status === 503) return 'busy';
  if (status === 502) return 'github-unavailable';
  log.error('a GitHub sign-in failed for a reason nobody anticipated', { status });
  return 'failed';
};

/** An `AuthResponse` as the `Response` the mounted routes answer with. */
const asResponse = (answer: AuthResponse, extraCookies: readonly string[] = []): Response => {
  const headers = new Headers();
  for (const cookie of [...extraCookies, ...answer.setCookie]) headers.append('set-cookie', cookie);
  if (answer.location === undefined) return new Response(null, { status: 204, headers });
  headers.set('location', answer.location);
  return new Response(null, { status: 302, headers });
};

/**
 * The library's answer to GitHub's callback, in Purlay's terms (D-121): a success goes home as the
 * library sent it, with its session cookie; anything else goes to the sign-in screen with one reason
 * from the closed set, the state spent, and nothing the library or GitHub said in the address.
 */
const callbackAnswer = (
  { config, log }: Pick<AuthDependencies, 'config' | 'log'>,
  request: Request,
  { response: answered, lostSignUpRace }: AuthAnswer,
): Response => {
  const sentRound = readCookie(request.headers.get('cookie'), RETRY_COOKIE) !== undefined;
  // Spent by whatever this callback answers: a marker is for the one round it was set for.
  const cookies = [
    ...answered.headers.getSetCookie(),
    ...(sentRound ? [clearedRetryCookie()] : []),
  ];
  // Two tabs of one person made the account at once and this one lost (D-78): its state is spent,
  // so it is sent round again — GitHub authorises without a prompt, and the library now finds the
  // account. Once: a tab that was sent round already and loses again is told it failed (R28).
  if (lostSignUpRace && !sentRound) {
    log.info('a GitHub sign-up lost to the same account made at once; sent round again');
    return asResponse(
      { setCookie: [retryCookie()], location: `${config.APP_URL}/auth/github` },
      cookies,
    );
  }
  const location = answered.headers.get('location');
  if (answered.status === 302 && location !== null) {
    const to = new URL(location, config.APP_URL);
    const isFailure =
      `${to.origin}${to.pathname}` === `${config.APP_URL}${SIGN_IN_PATH}` ||
      to.searchParams.has('error');
    if (!isFailure) {
      if (!sentRound) return answered;
      const headers = new Headers(answered.headers);
      headers.append('set-cookie', clearedRetryCookie());
      return new Response(answered.body, { status: answered.status, headers });
    }
    const failure = failureForLibraryCode(log, to.searchParams.get('error') ?? '');
    return asResponse(sentBack(config, failure), cookies);
  }
  return asResponse(sentBack(config, failureForStatus(log, answered.status)), cookies);
};

/**
 * The request as the library reads it: the client's address is the one this server decided on
 * (`clientAddress`, `TRUST_PROXY`), in the one header the library is told to read, and whatever a
 * client sent under that name is gone — so neither its limits nor a session's address can be
 * chosen by the client (D-138 §7).
 */
const carryingClientAddress = (request: Request, address: string | undefined): Request => {
  const headers = new Headers(request.headers);
  headers.delete(CLIENT_ADDRESS_HEADER);
  if (address !== undefined) headers.set(CLIENT_ADDRESS_HEADER, address);
  return new Request(request, { headers });
};

/**
 * A failure the library answered itself — a `5xx` it made of an error it caught — is written down
 * here, once: the library logs none of them, since its own errors are thrown to us
 * (`onAPIError.throw`) and only those it answers are left (D-78). The route and the status, and the
 * library's code only when it is one of its own known codes: never its message, which can carry
 * what a driver said — and never the path as sent, which a caller wrote and a reset's token travels
 * in; the route is one the library's own table spells (`Auth.routeOf`). The callback's are said by
 * `callbackAnswer`.
 */
const toldIfFailed = async (
  { auth, log }: Pick<AuthDependencies, 'auth' | 'log'>,
  url: URL,
  answered: Response,
): Promise<Response> => {
  if (answered.status < 500) return answered;
  const body: unknown = await answered
    .clone()
    .json()
    .catch(() => undefined);
  const code =
    typeof body === 'object' && body !== null
      ? (body as Readonly<Record<string, unknown>>)['code']
      : undefined;
  const known = typeof code === 'string' && Object.hasOwn(auth.$ERROR_CODES, code);
  log.error('the sign-in library answered a failure', {
    status: answered.status,
    path: auth.routeOf(url.pathname),
    ...(known ? { libraryCode: code } : {}),
  });
  return answered;
};

/**
 * A path the library has no route for — or one it is told to close — is the API's own 404, as every
 * path nobody serves is (`API.md` §1), never an empty body or the plain `Not Found` of a closed path,
 * which a client cannot read. A 404 the library answers in JSON is one of its own answers, and kept.
 */
const libraryOrNotFound = (answered: Response): Response => {
  if (
    answered.status === 404 &&
    !(answered.headers.get('content-type') ?? '').includes('application/json')
  ) {
    throw new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });
  }
  return answered;
};

/**
 * Everything under `AUTH_BASE_PATH` that no route of ours answers: the library's own routes, served
 * by its handler (D-179). Its callback for GitHub is the one exception to the library's own
 * answers, because only a browser arrives there (D-121):
 *
 * - **A cancel is read before the state is checked** (D-121 §4): `error=access_denied` carries no code,
 *   so nothing would be exchanged, and checking the state first would turn a cancel in a second tab
 *   into `expired`. Any other `error` GitHub sends back is the OAuth app's misconfiguration: `failed`,
 *   written down.
 * - **Everything else** is the library's to decide, and its answer is turned into ours.
 */
export const answerAuth = async (
  dependencies: AuthDependencies,
  received: Request,
  clientAddress: string | undefined,
): Promise<Response> => {
  const request = carryingClientAddress(received, clientAddress);
  const url = new URL(request.url);
  // No GitHub app yet (setup mode): the library has no provider to answer for, and what it does then is
  // a 500 and an error in the log. The start of a sign-in is the route that does not exist; a callback
  // is a browser, which is told its try is over (D-121).
  if (!dependencies.auth.github) {
    if (url.pathname === SOCIAL_SIGN_IN) throw notSetUp();
    if (url.pathname === SIGN_IN_CALLBACK) {
      dependencies.log.info('a GitHub callback arrived on a server with no GitHub app connected');
      return asResponse(sentBack(dependencies.config, 'expired'));
    }
  }
  if (url.pathname !== SIGN_IN_CALLBACK) {
    return libraryOrNotFound(
      await toldIfFailed(dependencies, url, await dependencies.auth.handler(request)),
    );
  }
  const declined = url.searchParams.get('error');
  if (declined !== null) {
    if (declined === DECLINED) return asResponse(sentBack(dependencies.config, 'cancelled'));
    dependencies.log.warn('GitHub refused a sign-in', {
      githubError: declined.slice(0, LOGGED_ERROR_LENGTH),
    });
    return asResponse(sentBack(dependencies.config, 'failed'));
  }
  return callbackAnswer(dependencies, request, await dependencies.auth.answer(request));
};

/** `GET /api/me/sign-in` — the ways the caller signs in, their own only (D-176). */
export const readMySignIn = async (
  dependencies: Pick<AuthDependencies, 'auth' | 'database'>,
  request: Request,
): Promise<MySignIn> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await mySignIn(dependencies.database, userId);
};

export const signOut = async (
  dependencies: SignOutDependencies,
  request: Request,
): Promise<AuthResponse> => {
  const session = await sessionFromHeaders(dependencies.auth, request.headers);
  await signOutOf(dependencies, session?.sessionId);
  return { setCookie: [clearedSessionCookie()] };
};

/** Signing out *everywhere* needs to know who you are, so it needs a live session. */
export const signOutEverywhere = async (
  dependencies: SignOutDependencies,
  request: Request,
): Promise<AuthResponse> => {
  const { userId } = await requireSession(dependencies.auth, request);
  await signOutEverywhereOf(dependencies, userId);
  return { setCookie: [clearedSessionCookie()] };
};

/**
 * `POST /api/me/erase` — the person erases their own account (D-139 §5): `204`, the cookie cleared, and
 * after the commit their sockets ended and each workspace they were in told to read its members again.
 */
export const eraseMyAccount = async (
  dependencies: SignOutDependencies,
  request: Request,
  body: unknown,
): Promise<AuthResponse> => {
  const { database, clock, bus } = dependencies;
  const caller = await requireSession(dependencies.auth, request);
  const { confirm } = validated(EraseAccountRequest, body);
  const erased = await atomicallyOn(database)(
    async (transaction) => await eraseAccount(transaction, clock, caller, confirm),
  );
  // Each told on its own: one that fails is logged, and the rest are still told. The person's sockets
  // first — every one, whatever session it holds — then each workspace's members (D-139 §5).
  await publishAfterCommit(dependencies.log, [
    [publication('SESSION_ENDED', () => publishUserDeleted(bus, clock, erased.userId))],
    erased.workspaces.map((workspace) =>
      publication('WORKSPACE_UPDATED', () =>
        publishWorkspaceUpdated(bus, clock, workspace.memberIds, workspace.id),
      ),
    ),
  ]);
  return { setCookie: [clearedSessionCookie()] };
};
