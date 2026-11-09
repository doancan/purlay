/**
 * How a request is named in what is written about it: its route as registered, never its path as sent, and the module
 * that owns the route. The request line, the failure line and the duration histogram all go through here, so a route is
 * spelled one way in the log and on the metrics page.
 */
import { AUTH_BASE_PATH } from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';
import type { Composition } from '../../composition';
import { CORE_OWNER, NO_OWNER } from '../../platform/module-kit/ownership';
import { currentRequest } from '../../platform/logging';
import type { ServerMetrics } from '../../platform/metrics';
import { methodLabel, routeLabel, statusLabel } from './metrics';
import { pathWithoutSecret } from './edge';

/**
 * The sign-in library's routes (D-179): everything under its base path no route of ours answers. The
 * registrations spell it as a literal, which `scripts/enforcement.test.ts` reads against
 * `API.md`; the request line's test binds the two spellings (`logging.integration.test.ts`).
 */
export const LIBRARY_ROUTE = `${AUTH_BASE_PATH}/*`;

export interface RequestObservation {
  /** The module that owns a route as registered. */
  readonly moduleOfRoute: (route: string | undefined) => string;
  /** The request log names the module for a module's route only. */
  readonly moduleField: (route: string | undefined) => { module?: string };
  /** One request's line on the page: never its path as sent, only the route it was registered as. */
  readonly observe: (method: string, route: string | undefined, status: number) => void;
  /**
   * The path a log line names a request by: as sent, except under the library's routes, where it is
   * the route as the library's own table spells it (`Auth.routeOf`) — a reset's token travels in a
   * path segment there, and nothing a caller wrote belongs in the log (D-179 §3) — and an incoming
   * webhook's, whose secret is its last segment (D-245).
   */
  readonly writtenPath: (route: string | undefined, path: string) => string;
}

export const requestObservation = (input: {
  readonly modules: Composition;
  readonly metrics: ServerMetrics;
  readonly auth: Auth;
}): RequestObservation => {
  const { modules, metrics, auth } = input;
  const moduleOfRoute = (route: string | undefined): string =>
    modules.owner.ofRoute(routeLabel(route));
  const moduleField = (route: string | undefined): { module?: string } => {
    const owner = moduleOfRoute(route);
    return owner === CORE_OWNER || owner === NO_OWNER ? {} : { module: owner };
  };
  const observe = (method: string, route: string | undefined, status: number): void => {
    const started = currentRequest()?.startedAt;
    if (started === undefined) return;
    metrics.httpDuration.observe(
      {
        method: methodLabel(method),
        route: routeLabel(route),
        status: statusLabel(status),
        module: moduleOfRoute(route),
      },
      (performance.now() - started) / 1000,
    );
  };
  const writtenPath = (route: string | undefined, path: string): string =>
    route === LIBRARY_ROUTE ? auth.routeOf(path) : pathWithoutSecret(path);
  return { moduleOfRoute, moduleField, observe, writtenPath };
};
