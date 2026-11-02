/**
 * `GET /metrics` (D-221, `API.md` §8): what this process has counted, in Prometheus's text format, for
 * the operator's scraper and nobody else.
 *
 * - **Off unless `METRICS_TOKEN` is set, and absent to whoever does not hold it.** Unset, a wrong token
 *   and no token are one answer, the `404 ROUTE_NOT_FOUND` of a path nothing serves — what the server's
 *   administration answers everybody but its administrator (`server.ts`), and what a resource in
 *   another workspace is (`CONTRIBUTING.md` §1.2). A `401` would tell a stranger the page is there and
 *   worth guessing at.
 * - **The token is compared in time that does not depend on it.** Both sides are hashed first, so
 *   neither where they differ nor how long the right one is can be timed.
 * - **The labels are the code's words, not the caller's.** A route is named as it was registered
 *   (`/api/channels/:channelId`), never as it was asked for; a method nobody serves is `OTHER`.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../platform/errors';
import type { MetricFamily } from '../../platform/exposition';
import type { Logger } from '../../platform/logging';
import { renderMetrics, type ServerMetrics } from '../../platform/metrics';

/** The methods a route is registered for; anything else is one label, so a caller cannot add series. */
const METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export const methodLabel = (method: string): string => (METHODS.has(method) ? method : 'OTHER');

/** `2xx`, `4xx` and so on: the class is what an alert reads, and five values stay five. */
export const statusLabel = (status: number): string =>
  Number.isInteger(status) && status >= 100 && status <= 599
    ? `${String(Math.floor(status / 100))}xx`
    : 'other';

/** A request turned away before routing, by the edge's own checks: it never had a route. */
export const EDGE_ROUTE = '(edge)';
/** A request no route answered, not even the client's catch-all (a method it does not take). */
export const UNMATCHED_ROUTE = '(unmatched)';

/** The route as the router registered it; a request that matched none has no name but this. */
export const routeLabel = (route: string | undefined): string =>
  route === undefined || route === '' ? UNMATCHED_ROUTE : route;

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Whether the request carries `Authorization: Bearer <token>` with this token. */
export const holdsMetricsToken = (authorization: string | null, token: string): boolean => {
  const presented = /^Bearer +(\S+)$/i.exec(authorization ?? '')?.[1];
  if (presented === undefined) return false;
  return timingSafeEqual(digest(presented), digest(token));
};

export interface MetricsDependencies {
  readonly token: string | undefined;
  readonly metrics: ServerMetrics;
  /** What is read for each scrape rather than kept: the scheduled jobs' record. */
  readonly read: () => Promise<readonly MetricFamily[]>;
  readonly log: Logger;
}

const absent = (): AppError => new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such route.' });

/** The page, or the refusal that looks like no page at all. */
export const answerMetrics = async (
  dependencies: MetricsDependencies,
  request: Request,
): Promise<string> => {
  const { token, metrics, read, log } = dependencies;
  if (token === undefined) throw absent();
  if (!holdsMetricsToken(request.headers.get('authorization'), token)) {
    // The operator's to know, when a scraper they set up is turned away; the caller is told nothing.
    log.info('a request for metrics was refused: no token, or not the one configured');
    throw absent();
  }
  return renderMetrics(metrics, await read());
};
