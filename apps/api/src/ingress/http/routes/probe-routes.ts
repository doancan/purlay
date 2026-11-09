/**
 * What the outside asks of a running node, for itself and not for a person: liveness, readiness and the operator's
 * metrics page. Readiness is also what the administration's operations page and a graceful shutdown (`startDraining`)
 * read, so the node's answer is made here once.
 */
import { Elysia, type AnyElysia } from 'elysia';
import { jobMetrics, readJobRuns } from '../../../modules/jobs/metrics';
import { PLAN } from '../../../modules/jobs/schedule';
import { EXPOSITION_CONTENT_TYPE } from '../../../platform/exposition';
import {
  moduleSuspendedFamily,
  modulesInfoFamily,
  type ServerMetrics,
} from '../../../platform/metrics';
import { outboxMetrics, readOutbox } from '../../../platform/outbox-report';
import {
  CORE_COLLATED_COLUMNS,
  readiness,
  recentReadiness,
  type Readiness,
} from '../../../platform/readiness';
import { answerMetrics } from '../metrics';
import type { RouteContext } from '../route-context';

/** Liveness. Deliberately touches nothing. */
const HEALTH = { status: 'ok' } as const;

export interface Probes {
  readonly routes: AnyElysia;
  /** Whether this node can serve now; false from `startDraining` on, whatever else is true. */
  readonly readiness: () => Promise<Readiness>;
  /** The first half of a graceful shutdown (#220): readiness answers 503 from now on. */
  readonly startDraining: () => void;
}

export const probeRoutes = (
  context: RouteContext,
  own: {
    readonly metrics: ServerMetrics;
    /** The modules the build carries that consume a fact, whether this process runs them or not: the rows wait for any node that does. */
    readonly outboxConsumers: readonly string[];
  },
): Probes => {
  const { dependencies, modules, moduleIds } = context;
  const { metrics, outboxConsumers } = own;
  const { log } = dependencies;
  /** Set once, by `startDraining`; readiness reads it before anything else. */
  let draining = false;
  // One check at a time, reused for a second, however often the outside asks (#636).
  const askReadiness = recentReadiness(
    async () =>
      await readiness(
        dependencies.database,
        [...CORE_COLLATED_COLUMNS, ...dependencies.collatedColumns],
        async () => await dependencies.auth.schemaProblem(),
        () => dependencies.shared?.problem(),
        modules.migrationSets,
      ),
    dependencies.clock,
  );
  // The reason a node is not ready is written once per check, not once per probe that hears it.
  let saidNotReady: Readiness | null = null;
  // The jobs run in the scheduler's container: their record is read from the database per scrape.
  const readJobs = jobMetrics({
    read: async () => await readJobRuns(dependencies.database),
    known: PLAN.map((slot) => slot.job),
    moduleOf: modules.owner.ofJob,
    log,
  });
  const readOutboxMetrics = outboxMetrics({
    read: async () =>
      await readOutbox(dependencies.database, outboxConsumers, dependencies.clock.now()),
    log,
  });
  const ready = async (): Promise<Readiness> =>
    draining ? { ready: false as const, reason: 'draining for shutdown' } : await askReadiness();
  const routes = new Elysia()
    .get('/health', () => HEALTH)
    /**
     * Readiness: the database answers, every migration is applied, and the
     * identifier columns compare byte-wise (#108). A word to the caller — health
     * discloses nothing about dependencies — and the reason to the log.
     */
    .get('/health/ready', async ({ set }) => {
      const answer = await ready();
      if (answer.ready) return { status: 'ready' } as const;
      if (answer !== saidNotReady) log.warn('not ready', { reason: answer.reason });
      saidNotReady = answer;
      set.status = 503;
      return { status: 'not ready' } as const;
    })
    // For the operator's scraper alone (D-221): without `METRICS_TOKEN`, or without its token, it is
    // the 404 of a path nothing serves.
    .get('/metrics', async ({ request, set }) => {
      const page = await answerMetrics(
        {
          token: dependencies.config.METRICS_TOKEN,
          metrics,
          read: async () => [
            modulesInfoFamily(moduleIds),
            moduleSuspendedFamily(moduleIds, modules.suspension.current()),
            ...(await readJobs()),
            ...(await readOutboxMetrics()),
          ],
          log,
        },
        request,
      );
      set.headers['content-type'] = EXPOSITION_CONTENT_TYPE;
      set.headers['cache-control'] = 'no-store';
      return page;
    });
  return {
    routes,
    readiness: ready,
    startDraining: (): void => {
      draining = true;
    },
  };
};
