/**
 * The scheduler container's process (D-30, #72): runs, once as it starts, each job that never succeeded
 * (`jobs:first`), then each job of `PLAN` at its time, each as its own `bun run job` process with the same environment. The configuration is read once here so a
 * scheduler that could not run a single job refuses to start, rather than failing every night.
 *
 * SIGTERM ends the wait at once; a job already running is let finish, within the stop grace.
 */
import { join } from 'node:path';
import { PLAN, runSchedule } from '../modules/jobs/schedule';
import { systemClock } from '../platform/clock';
import { loadConfig } from '../platform/config';
import { createLogger } from '../platform/logging';
import { installCrashHandlers } from '../lifecycle';
import { errorTrackingFor, reportUrgently } from '../platform/error-tracking';

const config = loadConfig(process.env);
const plainLog = createLogger({ level: config.LOG_LEVEL });
// What the scheduler logs at `error` is reported as the API's errors are (#635).
const { tracker, log } = errorTrackingFor(config, plainLog, systemClock);
// An error nothing handled ends the scheduler, reported, for its container to restart (#634).
installCrashHandlers({
  log: plainLog,
  report: reportUrgently(tracker),
  flush: tracker.flush,
  process,
  deadlineMs: 2_000,
});
const runner = join(import.meta.dir, 'jobs.ts');

let stopping = false;
let wake: () => void = () => undefined;
process.on('SIGTERM', () => {
  stopping = true;
  wake();
});

log.info('the scheduler is running', { jobs: PLAN.map((slot) => slot.job) });
await runSchedule({
  plan: PLAN,
  clock: systemClock,
  sleep: (ms) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
    }),
  run: async (job) => {
    const child = Bun.spawn([process.execPath, runner, job], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await child.exited;
  },
  stopped: () => stopping,
  log,
});
log.info('the scheduler stopped');
await tracker.flush();
