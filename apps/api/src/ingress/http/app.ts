/**
 * The HTTP surface.
 *
 * Ingress validates, delegates and serialises. It holds no business rule: the
 * layer below never sees an HTTP type, and lint enforces that direction
 * (`ARCHITECTURE.md` §4).
 *
 * **It takes no dependencies yet, deliberately.** A database handle threaded
 * through here today would have no consumer — `/health` is liveness and must
 * answer while the database is down. The handle arrives with the first route
 * that needs one, which is the rule the configuration loader already follows:
 * a thing is wired when the feature that needs it is built (D-57). It also makes
 * "`/health` cannot touch the database" structural rather than tested — there is
 * no database here to touch.
 *
 * **What it returns is the surface the caller uses, not the framework's type.**
 * Left to inference that is the accumulated type of every route, which under
 * `composite` lands in a committed `.d.ts` growing with routes × error branches
 * — 5 KB for six trivial routes when it was measured (`docs/spikes/elysia.md`).
 * Annotating it as the bare `Elysia` does not compile either: the type is
 * invariant in its routes, so a widened annotation is not assignable to itself
 * with one route added. Naming the two methods the composition root and the
 * tests actually call answers both, and leaves nothing above this file depending
 * on which framework is underneath.
 */
import { Elysia } from 'elysia';
import { refusalFor } from './errors';

/**
 * Everything outside ingress may do with the application.
 *
 * `handle` is what a test drives — a real `Request` in, a real `Response` out,
 * with no socket and no port. That is why the tests below are not integration
 * tests: they exercise the actual routing and the actual error handler.
 */
export interface HttpApplication {
  readonly handle: (request: Request) => Promise<Response>;
  readonly listen: (port: number) => void;
}

/** Liveness. Deliberately touches nothing. */
const HEALTH = { status: 'ok' } as const;

export const createApp = (): HttpApplication =>
  new Elysia()
    /**
     * One error handler for the whole surface, so a status is decided in exactly
     * one place. `set.status` rather than a thrown response: a second way to
     * choose a status is a second place for two of them to disagree.
     */
    .onError(({ code, error, set }) => {
      const issues = 'all' in error && Array.isArray(error.all) ? error.all : [];
      const refusal = refusalFor(code, error, issues);
      set.status = refusal.status;
      return refusal.body;
    })
    .get('/health', () => HEALTH);
