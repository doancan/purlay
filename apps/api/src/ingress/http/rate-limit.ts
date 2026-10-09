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

const STATE_CHANGING: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Seconds until one more request would be admitted, for `Retry-After`. At least one. */
export const retryAfterSeconds = (budget: RateBudget): number =>
  Math.max(1, Math.ceil(1 / budget.perSecond));

/** The budgets in force. A test that seeds hundreds of rows over HTTP passes a roomier one. */
export interface HttpBudgets {
  readonly auth: RateBudget;
  readonly writes: RateBudget;
}

export interface HttpLimitDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly trustProxy: boolean;
  /** Defaults to the provisional numbers above. */
  readonly budgets?: HttpBudgets;
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
  const budgets = dependencies.budgets ?? { auth: AUTH_BUDGET, writes: WRITE_BUDGET };
  const auth = inProcessRateLimiter(clock, budgets.auth);
  const writes = inProcessRateLimiter(clock, budgets.writes);

  return async (request, peer) => {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/auth/')) {
      const address = clientAddress(peer, request.headers, trustProxy);
      return (await auth.consume(limitKeyFor(address)))
        ? undefined
        : retryAfterSeconds(budgets.auth);
    }

    if (pathname.startsWith('/api/') && STATE_CHANGING.has(request.method)) {
      // Whoever the session names. No valid session means the handler will say 401;
      // there is no user to charge, and no bucket is created for an unknown caller.
      const token = sessionTokenFrom(request.headers.get('cookie'));
      const owner = token === undefined ? undefined : await resolveSession(database, clock, token);
      if (owner === undefined) return undefined;
      return (await writes.consume(owner.userId)) ? undefined : retryAfterSeconds(budgets.writes);
    }

    return undefined;
  };
};
