/**
 * The scheduler the deployment ships with (D-30, #72): one container beside the API, so a job runs
 * once however many API nodes there are, and it is installed by `docker compose up` rather than by
 * somebody remembering a crontab. Each run is its own process (`bun run job <name>`), so a job that
 * crashes takes nothing else with it, and every run is recorded by the job itself (`job_runs`).
 *
 * Times are UTC and fixed, not every-N-hours from whenever the container started: a restart neither
 * skips a night nor runs a job twice in a row — except a job that has never succeeded, which runs
 * once at start (`FIRST_RUN`).
 */
import { DAY_MS, HOUR_MS, type Clock } from '../../platform/clock';

export type Slot = { readonly job: string; readonly minute: number } & (
  { readonly every: 'hour' } | { readonly every: 'day'; readonly hour: number }
);

/** The jobs, at quiet times and apart, so a slow one does not overlap the next. */
export const PLAN: readonly Slot[] = [
  { job: 'sweep:sessions', every: 'hour', minute: 15 },
  { job: 'sweep:orphans', every: 'day', hour: 3, minute: 0 },
  { job: 'reconcile:storage', every: 'day', hour: 3, minute: 30 },
  { job: 'sweep:link-previews', every: 'day', hour: 4, minute: 0 },
  { job: 'sweep:github-deliveries', every: 'day', hour: 4, minute: 30 },
  { job: 'sweep:email-sign-ins', every: 'day', hour: 4, minute: 45 },
];

/** The first instant after `after` at which the slot is due. */
export const nextRun = (slot: Slot, after: Date): Date => {
  const candidate = new Date(after);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(slot.minute);
  if (slot.every === 'day') candidate.setUTCHours(slot.hour);
  const step = slot.every === 'hour' ? HOUR_MS : DAY_MS;
  while (candidate.getTime() <= after.getTime()) candidate.setTime(candidate.getTime() + step);
  return candidate;
};

export interface SchedulePorts {
  readonly plan: readonly Slot[];
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  /** Runs the job to its end and answers its exit code. */
  readonly run: (job: string) => Promise<number>;
  /** True once the container is being stopped. */
  readonly stopped: () => boolean;
  readonly log: {
    readonly info: (msg: string, fields?: Record<string, unknown>) => void;
    readonly error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

/**
 * Run before the first slot: each job that has never succeeded, once (`jobs:first`). A restart of a
 * deployment whose jobs all worked once runs nothing more, so the rule above still holds for them.
 */
export const FIRST_RUN = 'jobs:first';

export const runSchedule = async (ports: SchedulePorts): Promise<void> => {
  const { plan, clock, sleep, run, stopped, log } = ports;
  const report = async (job: string): Promise<void> => {
    const exitCode = await run(job);
    if (exitCode === 0) log.info('a scheduled job ran', { job });
    else log.error('a scheduled job exited with a failure', { job, exitCode });
  };
  let from = clock.now();
  if (stopped()) return;
  await report(FIRST_RUN);
  while (!stopped()) {
    const due = plan
      .map((slot) => ({ job: slot.job, at: nextRun(slot, from) }))
      .reduce((soonest, next) => (next.at < soonest.at ? next : soonest));
    await sleep(Math.max(0, due.at.getTime() - clock.now().getTime()));
    if (stopped()) return;
    await report(due.job);
    from = due.at;
  }
};
