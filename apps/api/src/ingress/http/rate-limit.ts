/**
 * Which HTTP requests are rate limited, by what, and for how long a refusal waits.
 *
 * The socket limits frames per connection (D-66). HTTP had no limit at all, so
 * two doors to one `send()` had two budgets, one of them unlimited, and `/auth/*`
 * could be driven to spend the OAuth application's own GitHub quota (#235).
 * Both limiters are the same seam the socket uses (`RateLimiter`, D-7), so a
 * shared implementation for several nodes replaces them in one place (D-25).
 *
 * **The numbers are provisional (O-4).** Nothing has been measured yet, and
 * they say so here and in `CONFIG.md` rather than looking decided.
 */
import type { Clock } from '../../platform/clock';
import type { Auth } from '../../modules/auth/better-auth';
import { sessionFromHeaders } from '../../modules/auth/sessions';
import {
  inProcessRateLimiter,
  SOCKET_FRAME_BUDGET,
  type RateBudget,
  type RateLimiter,
} from '../../realtime/rate-limiter';
import { limitKeyFor } from '../../platform/client-key';
import { clientAddress } from './client-address';

/**
 * Sign-in traffic per client address: thirty requests at once, then one every
 * two seconds. A sign-in is two requests (the redirect and the callback), so an
 * office behind one NAT can sign thirty people in together, which a lower
 * burst would not allow. Provisional (O-4).
 */
export const AUTH_BUDGET: RateBudget = { perSecond: 0.5, burst: 30 };

/**
 * Writes per signed-in user: the socket's own budget, so the two doors to
 * `send()` cost the same. Keyed by user rather than connection (D-66 rejected
 * that for the socket, where two tabs would starve each other): HTTP has no
 * connection to key on, and a user's writes are one person's. Provisional (O-4).
 */
export const WRITE_BUDGET: RateBudget = SOCKET_FRAME_BUDGET;

/**
 * Reads that cost the server on the reader's behalf — a card's GitHub call, an image's fetch and
 * decode — per signed-in user: sixty at once, then ten a second. Drawing a channel asks for one per
 * link it shows, so they have a bucket of their own: charged to the writes, a page of GitHub links
 * spent what the person sends with. Provisional (O-4).
 */
export const COSTLY_READ_BUDGET: RateBudget = { perSecond: 10, burst: 60 };

/**
 * Calls to GitHub per workspace: a hundred at once, then one a second — under the hourly quota of the
 * workspace's one token (5,000 at the time of writing), whoever is asking. Without it one member could
 * ask for links nobody wrote and spend the token for everyone (found by review). Provisional (O-4).
 */
export const GITHUB_CALL_BUDGET: RateBudget = { perSecond: 1, burst: 100 };

/**
 * Deliveries to the webhook per client address (a /64 for IPv6), before anything is looked up: two
 * hundred at once, then twenty a second — so one address cannot spend the work of checking signatures
 * without end, nor take every other address's turn. GitHub's own deliveries come from a few of its
 * addresses, well inside it. Provisional (O-4).
 */
export const WEBHOOK_BUDGET: RateBudget = { perSecond: 20, burst: 200 };

/**
 * Posts per feed, once its signature held: a hundred at once — a merge train, a mass close — then
 * two a second. Charged after the signature, so nobody but the repository spends it. Provisional (O-4).
 */
export const WEBHOOK_FEED_BUDGET: RateBudget = { perSecond: 2, burst: 100 };

/**
 * The setup's routes per client (a /64 for IPv6), before anything is weighed (D-179 §4.1): thirty at
 * once, then one every thirty seconds — thirty in fifteen minutes. A wizard walked by one person asks a
 * few each step. The server's own lock on wrong codes can be kept shut by anybody who reaches the
 * route; this is what keeps one client from doing it fast. Provisional (O-4).
 */
export const SETUP_BUDGET: RateBudget = { perSecond: 1 / 30, burst: 30 };

/**
 * The two setup routes that weigh a secret — the code (`/setup/claim`) and the address link
 * (`/setup/verify`) — per client: ten at once, then one every ninety seconds — ten in fifteen minutes.
 * Neither needs a claim, so a stranger reaches both. Provisional (O-4).
 */
export const SETUP_SECRET_BUDGET: RateBudget = { perSecond: 1 / 90, burst: 10 };

/**
 * Asking for an invitation passport per client (a /64 for IPv6), before the link is looked at (D-179 §5,
 * R51): ten at once, then one every ninety seconds — ten in fifteen minutes. The route is public and a
 * token in its body is all it needs, so this is what keeps one client from guessing at links, or from
 * filling a link's twenty places. Provisional (O-4).
 */
const PASSPORT_BUDGET: RateBudget = { perSecond: 1 / 90, burst: 10 };

/**
 * Administration → Server per client (a /64 for IPv6), before the session is looked at: sixty at once,
 * then one every fifteen seconds — sixty in fifteen minutes. A page walked by one administrator asks
 * a handful. Charged to every method on every path under `/api/server`, to anybody who reaches it, so
 * a stranger cannot spend the guard's work and an administrator's stolen session cannot probe fast.
 * Provisional (O-4).
 */
export const SERVER_ADMIN_BUDGET: RateBudget = { perSecond: 1 / 15, burst: 60 };

/** Whether a path is Administration → Server's. */
const isServerAdminPath = (pathname: string): boolean =>
  pathname === '/api/server' || pathname.startsWith('/api/server/');

/**
 * The setup's routes, by the class each is charged to. Exact routes, as the router matches them, so
 * `GET /setup` and `GET /setup/verify` — the client's pages — are not charged. The status is asked by
 * the sign-in screen before anybody signs in, so it is sign-in traffic, charged to `AUTH_BUDGET`.
 */
const SETUP_ROUTES: ReadonlyMap<string, 'auth' | 'setup' | 'setupSecrets'> = new Map([
  ['GET /setup/status', 'auth'],
  ['POST /setup/claim', 'setupSecrets'],
  ['POST /setup/verify', 'setupSecrets'],
  ['GET /setup/state', 'setup'],
  ['POST /setup/address', 'setup'],
  ['POST /setup/admin', 'setup'],
  ['POST /setup/policy', 'setup'],
  ['POST /setup/github', 'setup'],
  ['POST /setup/smtp', 'setup'],
  ['POST /setup/workspace', 'setup'],
  ['POST /setup/invite', 'setup'],
  ['POST /setup/finish', 'setup'],
]);

/** The routes charged to `COSTLY_READ_BUDGET`: what a screen asks for to draw, whatever the method. */
const COSTLY_READS: ReadonlySet<string> = new Set([
  '/api/images',
  '/api/integrations/github/unfurl',
]);

/** The route that makes an invitation passport, charged to `PASSPORT_BUDGET`. */
const PASSPORT_ROUTE = '/api/invitations/passport';

const STATE_CHANGING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A path as the router matches it: the router is not strict, so `/api/images/` reaches the same
 * handler as `/api/images`, and a limiter comparing the raw path let that spelling through uncharged
 * (found by review). Repeated slashes are one, and a trailing one is dropped.
 */
const routeOf = (pathname: string): string => {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
};

/** Seconds until one more request would be admitted, for `Retry-After`. At least one. */
export const retryAfterSeconds = (budget: RateBudget): number =>
  Math.max(1, Math.ceil(1 / budget.perSecond));

/** The budgets in force. A test that seeds hundreds of rows over HTTP passes a roomier one. */
export interface HttpBudgets {
  readonly auth: RateBudget;
  readonly writes: RateBudget;
  readonly costlyReads: RateBudget;
  /** Absent: the provisional numbers, so a test about something else keeps the real setup limits. */
  readonly setup?: RateBudget;
  readonly setupSecrets?: RateBudget;
  readonly passports?: RateBudget;
  readonly serverAdmin?: RateBudget;
}

export interface HttpLimitDependencies {
  /** Who a write is charged to: the session, resolved as every request's is. */
  readonly auth: Auth;
  readonly clock: Clock;
  readonly trustProxy: boolean;
  /** Defaults to the provisional numbers above. */
  readonly budgets?: HttpBudgets;
  /**
   * The per-user write bucket. Passed in when the socket door charges the same one,
   * so a user's writes cost the same over either door; made here otherwise.
   */
  readonly writes?: RateLimiter;
}

/**
 * Returns the seconds to wait when the request is over budget, `undefined` when
 * it may proceed.
 *
 * `peer` is the socket's remote address, which only the server knows; the
 * request alone cannot say.
 */
export type AdmitHttp = (request: Request, peer: string | undefined) => Promise<number | undefined>;

export const httpLimits = (dependencies: HttpLimitDependencies): AdmitHttp => {
  const { auth: sessions, clock, trustProxy } = dependencies;
  const budgets = dependencies.budgets ?? {
    auth: AUTH_BUDGET,
    writes: WRITE_BUDGET,
    costlyReads: COSTLY_READ_BUDGET,
    setup: SETUP_BUDGET,
    setupSecrets: SETUP_SECRET_BUDGET,
    passports: PASSPORT_BUDGET,
    serverAdmin: SERVER_ADMIN_BUDGET,
  };
  const auth = inProcessRateLimiter(clock, budgets.auth);
  const writes = dependencies.writes ?? inProcessRateLimiter(clock, budgets.writes);
  const costlyReads = inProcessRateLimiter(clock, budgets.costlyReads);
  const setupBudget = budgets.setup ?? SETUP_BUDGET;
  const setupSecretBudget = budgets.setupSecrets ?? SETUP_SECRET_BUDGET;
  const passportBudget = budgets.passports ?? PASSPORT_BUDGET;
  const passports = inProcessRateLimiter(clock, passportBudget);
  const serverAdminBudget = budgets.serverAdmin ?? SERVER_ADMIN_BUDGET;
  const serverAdmin = inProcessRateLimiter(clock, serverAdminBudget);
  const byClass = {
    auth: [auth, budgets.auth],
    setup: [inProcessRateLimiter(clock, setupBudget), setupBudget],
    setupSecrets: [inProcessRateLimiter(clock, setupSecretBudget), setupSecretBudget],
  } as const;

  return async (request, peer) => {
    const pathname = routeOf(new URL(request.url).pathname);
    // The router answers `HEAD` with the `GET` handler (Elysia): charged as the `GET` it runs (review).
    const method = request.method === 'HEAD' ? 'GET' : request.method;

    // Before the claim is looked at or a code weighed: nothing on these needs a session.
    const setupClass = SETUP_ROUTES.get(`${method} ${pathname}`);
    if (setupClass !== undefined) {
      const [bucket, budget] = byClass[setupClass];
      const address = clientAddress(peer, request.headers, trustProxy);
      return (await bucket.consume(limitKeyFor(address))) ? undefined : retryAfterSeconds(budget);
    }

    // Before the session is looked at: the guard's work is not a stranger's to spend.
    if (isServerAdminPath(pathname)) {
      const address = clientAddress(peer, request.headers, trustProxy);
      return (await serverAdmin.consume(limitKeyFor(address)))
        ? undefined
        : retryAfterSeconds(serverAdminBudget);
    }

    // Public, so charged to the client, before the link in the body is looked at.
    if (method === 'POST' && pathname === PASSPORT_ROUTE) {
      const address = clientAddress(peer, request.headers, trustProxy);
      return (await passports.consume(limitKeyFor(address)))
        ? undefined
        : retryAfterSeconds(passportBudget);
    }

    // Asked by a client before anybody has signed in, as the sign-in screen asks the setup's status: it is
    // sign-in traffic, charged to the client's address (D-186).
    if (method === 'GET' && pathname === '/api/client') {
      const address = clientAddress(peer, request.headers, trustProxy);
      return (await auth.consume(limitKeyFor(address)))
        ? undefined
        : retryAfterSeconds(budgets.auth);
    }

    if (pathname.startsWith('/auth/')) {
      const address = clientAddress(peer, request.headers, trustProxy);
      return (await auth.consume(limitKeyFor(address)))
        ? undefined
        : retryAfterSeconds(budgets.auth);
    }

    // A card or an external image costs the server a call on the reader's behalf (#110): charged, so
    // one person cannot spend the node on it — to its own bucket, so drawing never spends sending.
    const costly = COSTLY_READS.has(pathname);
    if (pathname.startsWith('/api/') && (STATE_CHANGING.has(method) || costly)) {
      // Whoever the session names. No valid session means the handler will say 401;
      // there is no user to charge, and no bucket is created for an unknown caller.
      const owner = await sessionFromHeaders(sessions, request.headers);
      if (owner === undefined) return undefined;
      const [bucket, budget] = costly
        ? [costlyReads, budgets.costlyReads]
        : [writes, budgets.writes];
      return (await bucket.consume(owner.userId)) ? undefined : retryAfterSeconds(budget);
    }

    return undefined;
  };
};
