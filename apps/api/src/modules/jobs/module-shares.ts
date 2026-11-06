/**
 * A module's scheduled job runs as a module's request does (`MODULES.md` §7, D-274, D-266, D-270): through the share of the
 * pool its module declared, against the deadline its manifest gives, with an error boundary that is the run's alone.
 *
 * The job command opens one pool for the process and every run of a job is noted, as a request is, as the module's: the
 * connections its work takes are asked of the module's share, each held to the module's statement limit, and past the
 * deadline the work's signal aborts, the database is told to cancel the statement it is running and what the work asks next
 * is refused. The core's jobs stay on the pool as it is. Whatever the work did, the run's record — `job_runs`, the log line,
 * the counters — is written on the pool as it is, by the runner, so a job cut off at its deadline is still told as a failure.
 */
import { leasingExecutor, type DatabasePool, type Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { withinRequest, type Logger } from '../../platform/logging';
import type { ModuleManifest } from '../../platform/module-kit/manifest';
import { moduleConnections } from '../../platform/module-budget';
import { withDeadline } from '../../platform/request-deadline';
import { runJob, type Outcome } from './jobs';

/** Past a night's longest purge on the instances this runs on, and a fraction of the day the scheduler's one-at-a-time plan has. */
export const DEFAULT_JOB_DEADLINE_MS = 600_000;

/** What the work of a job is given as its database: the module's share for a module's job, the pool as it is for the core's. */
export type JobWorkOn = (database: Executor) => Promise<Outcome>;

/** A run that went past its deadline: the work was cancelled and the run is recorded as failed. */
class JobDeadlineError extends Error {
  constructor(job: string, module: string, ms: number) {
    super(
      `The job "${job}" of the ${module} module ran past its deadline of ${String(ms)} ms and was stopped.`,
    );
    this.name = 'JobDeadlineError';
  }
}

/** The deadline of a module's jobs in milliseconds, `undefined` for one that declared `none`. */
export const jobDeadlinesOf = (
  manifests: readonly Pick<ModuleManifest, 'id' | 'jobDeadline'>[],
): ((moduleId: string) => number | undefined) => {
  const byModule = new Map(
    manifests.map(({ id, jobDeadline }) => [
      id,
      jobDeadline === undefined
        ? DEFAULT_JOB_DEADLINE_MS
        : 'ms' in jobDeadline
          ? jobDeadline.ms
          : undefined,
    ]),
  );
  return (moduleId) => byModule.get(moduleId);
};

const OVERRAN = Symbol('the job ran past its deadline');

export interface ScheduledJobRunnerDependencies {
  /** The process's pool as it is: the runner's record of each run is written on it, and the core's jobs work on it. */
  readonly database: DatabasePool;
  readonly clock: Clock;
  readonly log: Logger;
  /** Every module the build carries: a module's job is run in the share and the deadline its manifest declares. */
  readonly manifests: readonly Pick<ModuleManifest, 'id' | 'budget' | 'jobDeadline'>[];
  readonly poolMax: number;
  /** The module a job is for, or the core (`platform/module-kit/ownership.ts`): the label of its lines. */
  readonly ownerOf: (job: string) => string;
}

/**
 * Runs one job to its end and says whether it succeeded. A failure — a throw, a refusal of the share, the deadline — is
 * recorded, logged with the module and answered `false`; it is not thrown, so the caller goes on to the next job.
 */
export const scheduledJobRunner = (
  dependencies: ScheduledJobRunnerDependencies,
): ((job: string, work: JobWorkOn) => Promise<boolean>) => {
  const { database, clock, log, manifests, poolMax, ownerOf } = dependencies;
  const leased = leasingExecutor(database, moduleConnections(manifests, poolMax));
  const deadlineOf = jobDeadlinesOf(manifests);
  const modules = new Set(manifests.map(({ id }) => id));
  return async (job, work) => {
    const owner = ownerOf(job);
    const owned = log.child({ module: owner });
    const inShare = async (): Promise<Outcome> => {
      if (!modules.has(owner)) return await work(database);
      const ms = deadlineOf(owner);
      const run = (signal?: AbortSignal): Promise<Outcome> =>
        withinRequest(
          {
            requestId: `job:${job}`,
            startedAt: performance.now(),
            module: owner,
            ...(signal === undefined ? {} : { signal }),
          },
          async () => await work(leased),
        );
      if (ms === undefined) return await run();
      const outcome = await withDeadline<Outcome | typeof OVERRAN>(ms, run, () => OVERRAN);
      if (outcome === OVERRAN) throw new JobDeadlineError(job, owner, ms);
      return outcome;
    };
    return await runJob({ database, clock, log: owned }, job, inShare).then(
      () => true,
      () => false,
    );
  };
};
