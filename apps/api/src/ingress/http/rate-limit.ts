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
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { sessionTokenFrom } from '../../platform/cookies';
import { resolveSession } from '../../modules/auth/sessions';
import {
  inProcessRateLimiter,
  SOCKET_FRAME_BUDGET,
  type RateBudget,
  type RateLimiter,
} from '../../realtime/rate-limiter';
import { clientAddress, limitKeyFor } from './client-address';

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

/** The routes charged to `COSTLY_READ_BUDGET`: what a screen asks for to draw, whatever the method. */
const COSTLY_READS: ReadonlySet<string> = new Set([
  '/api/images',
  '/api/integrations/github/unfurl',
]);

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
}

export interface HttpLimitDependencies {
  readonly database: Executor;
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
  const { database, clock, trustProxy } = dependencies;
  const budgets = dependencies.budgets ?? {
    auth: AUTH_BUDGET,
    writes: WRITE_BUDGET,
    costlyReads: COSTLY_READ_BUDGET,
  };
  const auth = inProcessRateLimiter(clock, budgets.auth);
  const writes = dependencies.writes ?? inProcessRateLimiter(clock, budgets.writes);
  const costlyReads = inProcessRateLimiter(clock, budgets.costlyReads);

  return async (request, peer) => {
    const pathname = routeOf(new URL(request.url).pathname);

    if (pathname.startsWith('/auth/')) {
      const address = clientAddress(peer, request.headers, trustProxy);
      return (await auth.consume(limitKeyFor(address)))
        ? undefined
        : retryAfterSeconds(budgets.auth);
    }

    // A card or an external image costs the server a call on the reader's behalf (#110): charged, so
    // one person cannot spend the node on it — to its own bucket, so drawing never spends sending.
    const costly = COSTLY_READS.has(pathname);
    if (pathname.startsWith('/api/') && (STATE_CHANGING.has(request.method) || costly)) {
      // Whoever the session names. No valid session means the handler will say 401;
      // there is no user to charge, and no bucket is created for an unknown caller.
      const token = sessionTokenFrom(request.headers.get('cookie'));
      const owner = token === undefined ? undefined : await resolveSession(database, clock, token);
      if (owner === undefined) return undefined;
      const [bucket, budget] = costly
        ? [costlyReads, budgets.costlyReads]
        : [writes, budgets.writes];
      return (await bucket.consume(owner.userId)) ? undefined : retryAfterSeconds(budget);
    }

    return undefined;
  };
};
