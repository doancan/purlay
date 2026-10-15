/**
 * `bun run job <name>` — the scheduled jobs, run by an external scheduler (D-30), never by the API.
 *
 *   sweep:orphans      unsent uploads older than a day, and their objects (D-109 §5)
 *   sweep:sessions     sessions that expired or were revoked
 *   reconcile:storage  each workspace's storage count put back to the bytes it holds (I-7)
 *   sweep:link-previews  the unfurl cache past its expiry (D-23)
 *   sweep:email-sign-ins  sign-in links and notes a day old (D-138)
 *   purge:retention    each workspace's history past the days it keeps (D-27, D-139)
 *   sweep:exports      exports nobody downloaded in time, and any whose making was cut off (D-140)
 *   sweep:deletions    objects whose rows are gone, tried again until the store lets them go (D-141)
 *   jobs:status        what each job last did; exits non-zero when one is overdue or never ran
 *   jobs:first         each job that has never succeeded, once; what the scheduler runs as it starts
 *
 * It reads the deployment's own configuration, as the API does, so it runs in the same image with
 * the same environment. A job's failure is recorded, logged and exits non-zero.
 */
import { sweepObjectDeletions } from '../modules/attachments/deletions';
import { sweepExports } from '../modules/export/requests';
import { purgeRetention } from '../modules/retention/purge';
import { createDatabase, purgeDeadSessions } from '@purlay/db';
import {
  reconcileStorage,
  runJob,
  sweepEmailSignIns,
  sweepGitHubDeliveries,
  sweepLinkPreviews,
  sweepOrphans,
} from '../modules/jobs/jobs';
import { jobReport, neverSucceeded } from '../modules/jobs/report';
import { FIRST_RUN } from '../modules/jobs/schedule';
import { systemClock } from '../platform/clock';
import { loadConfig } from '../platform/config';
import { databaseConnection } from '../platform/database';
import { atomicallyOn } from '../platform/transactions';
import { createLogger } from '../platform/logging';
import { errorTrackingFor } from '../platform/error-tracking';
import { storeFor } from '../platform/storage';

/** Sessions one statement of the sweep removes. */
const SESSION_BATCH = 1_000;

const config = loadConfig(process.env);
// A job's failure is logged at `error`, and so reported as the API's errors are (#635).
const { tracker, log } = errorTrackingFor(
  config,
  createLogger({ level: config.LOG_LEVEL }),
  systemClock,
);
const database = createDatabase({ ...databaseConnection(config, log), poolSize: 2 });
const clock = systemClock;

const jobs: Readonly<Record<string, () => Promise<Readonly<Record<string, number>>>>> = {
  'sweep:orphans': async () =>
    await sweepOrphans({ database, clock, log, storage: storeFor(config) }),
  'sweep:sessions': async () => {
    let removed = 0;
    for (let batch = SESSION_BATCH; batch === SESSION_BATCH; removed += batch) {
      batch = await purgeDeadSessions(database, clock.now(), SESSION_BATCH);
    }
    return { removed };
  },
  'reconcile:storage': async () => await reconcileStorage({ database, log }),
  'sweep:link-previews': async () => await sweepLinkPreviews({ database, clock }),
  'sweep:github-deliveries': async () => await sweepGitHubDeliveries({ database, clock }),
  'sweep:email-sign-ins': async () => await sweepEmailSignIns({ database, clock }),
  'sweep:exports': async () =>
    await sweepExports({ database, clock, log, storage: storeFor(config) }),
  'purge:retention': async () =>
    await purgeRetention({ database, clock, log, storage: storeFor(config) }),
  'sweep:deletions': async () =>
    await sweepObjectDeletions({
      database,
      atomically: atomicallyOn(database),
      log,
      storage: storeFor(config),
    }),
};

const records = async (): Promise<Parameters<typeof jobReport>[1]> =>
  await database
    .selectFrom('job_runs')
    .select(['job_name', 'last_success_at', 'consecutive_failures', 'last_error'])
    .execute();

/** Runs one job; true when it succeeded. Its failure is recorded and logged by the runner. */
const runOne = async (
  job: string,
  work: () => Promise<Readonly<Record<string, number>>>,
): Promise<boolean> =>
  await runJob({ database, clock, log }, job, work).then(
    () => true,
    () => false,
  );

const name = process.argv[2] ?? '';
try {
  if (name === 'jobs:status') {
    const report = jobReport(Object.keys(jobs), await records(), clock.now());
    process.stdout.write(`${report.lines.join('\n')}\n`);
    process.exitCode = report.healthy ? 0 : 1;
  } else if (name === FIRST_RUN) {
    // One after another, as the plan would: a failure is told by the exit code, and the rest still run.
    for (const job of neverSucceeded(Object.keys(jobs), await records())) {
      const work = jobs[job];
      if (work === undefined) throw new Error(`no job named "${job}" to run first`);
      if (!(await runOne(job, work))) process.exitCode = 1;
    }
  } else {
    const work = jobs[name];
    if (work === undefined) {
      process.stderr.write(
        `No job named "${name}". Jobs: ${[...Object.keys(jobs), 'jobs:status', FIRST_RUN].join(', ')}\n`,
      );
      process.exitCode = 2;
    } else if (!(await runOne(name, work))) {
      // The scheduler is told by the exit code.
      process.exitCode = 1;
    }
  }
} finally {
  await database.destroy();
  // The report of a failure leaves before the process does, within the tracker's own bound.
  await tracker.flush();
}
