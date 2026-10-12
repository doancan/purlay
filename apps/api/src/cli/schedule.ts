/**
 * The scheduler container's process (D-30, #72): runs each job of `PLAN` at its time, each as its
 * own `bun run job` process with the same environment. The configuration is read once here so a
 * scheduler that could not run a single job refuses to start, rather than failing every night.
 *
 * SIGTERM ends the wait at once; a job already running is let finish, within the stop grace.
 */
import { join } from 'node:path';
import { PLAN, runSchedule } from '../modules/jobs/schedule';
import { systemClock } from '../platform/clock';
import { loadConfig } from '../platform/config';
import { createLogger } from '../platform/logging';

const config = loadConfig(process.env);
const log = createLogger({ level: config.LOG_LEVEL });
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
