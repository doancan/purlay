/**
 * The scheduled jobs on `/metrics` (D-221): read from `job_runs`, what `jobs:status` reads (D-30).
 *
 * The jobs run in the scheduler's container, each as a process of its own, so nothing the API counts
 * in memory would ever see one. What every run leaves is its row: when it last succeeded and how many
 * times it has failed since. That is read when the page is asked for, and said as it is — a count of
 * every run ever is not kept anywhere, so it is not invented here.
 *
 * A read that fails or is slow does not fail the page: the process's own numbers are still worth
 * having while the database is the trouble. It says so as `purlay_jobs_status_readable 0`, and the
 * log says it once, when it starts failing, not at every scrape.
 */
import type { Executor } from '@purlay/db';
import type { MetricFamily } from '../../platform/exposition';
import type { Logger } from '../../platform/logging';

/** Longer than a healthy read takes by orders of magnitude, and well inside a scrape's own timeout. */
const JOB_READ_TIMEOUT_MS = 2_000;

export interface JobRun {
  readonly job_name: string;
  readonly last_success_at: Date | null;
  readonly consecutive_failures: number;
}

export const readJobRuns = async (database: Executor): Promise<readonly JobRun[]> =>
  await database
    .selectFrom('job_runs')
    .select(['job_name', 'last_success_at', 'consecutive_failures'])
    .execute();

/**
 * The families for the jobs the deployment runs, in the order given. A row for a name not in `known`
 * is left out — a job since retired — so the series are the plan's and no more; a job with no row has
 * never succeeded, and has no last success to say.
 */
export const jobFamilies = (
  known: readonly string[],
  runs: readonly JobRun[] | undefined,
): readonly MetricFamily[] => {
  const readable: MetricFamily = {
    name: 'purlay_jobs_status_readable',
    help: 'Whether the scheduled jobs’ record could be read for this scrape (1) or not (0).',
    type: 'gauge',
    samples: [{ suffix: '', labels: {}, value: runs === undefined ? 0 : 1 }],
  };
  if (runs === undefined) return [readable];
  const rowOf = (job: string): JobRun | undefined => runs.find((run) => run.job_name === job);
  return [
    readable,
    {
      name: 'purlay_job_last_success_timestamp_seconds',
      help: 'When each scheduled job last succeeded, in seconds since the epoch; absent for one that never has.',
      type: 'gauge',
      samples: known.flatMap((job) => {
        const at = rowOf(job)?.last_success_at;
        return at == null ? [] : [{ suffix: '', labels: { job }, value: at.getTime() / 1000 }];
      }),
    },
    {
      name: 'purlay_job_consecutive_failures',
      help: 'How many times each scheduled job has failed since it last succeeded.',
      type: 'gauge',
      samples: known.map((job) => ({
        suffix: '',
        labels: { job },
        value: rowOf(job)?.consecutive_failures ?? 0,
      })),
    },
  ];
};

export interface JobMetricsDependencies {
  readonly read: () => Promise<readonly JobRun[]>;
  readonly known: readonly string[];
  readonly log: Logger;
  readonly timeoutMs?: number;
}

/** Reads the record for each scrape, bounded, and says a failure to read it once until it reads again. */
export const jobMetrics = (
  dependencies: JobMetricsDependencies,
): (() => Promise<readonly MetricFamily[]>) => {
  const { read, known, log, timeoutMs = JOB_READ_TIMEOUT_MS } = dependencies;
  let failing = false;
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => {
        resolve('late');
      }, timeoutMs);
    });
    try {
      const runs = await Promise.race([read(), late]);
      if (runs === 'late') throw new Error(`no answer within ${String(timeoutMs)} ms`);
      failing = false;
      return jobFamilies(known, runs);
    } catch (error) {
      // Not swallowed: the page says it as a 0 a rule can alert on, and the log says why, once.
      if (!failing)
        log.warn('the scheduled jobs’ record could not be read for metrics', { err: error });
      failing = true;
      return jobFamilies(known, undefined);
    } finally {
      clearTimeout(timer);
    }
  };
};
