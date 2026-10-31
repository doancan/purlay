import { describe, expect, test } from 'bun:test';
import { exposition } from '../../platform/exposition';
import { aRecordingLogger } from '../../testing/doubles';
import { readExposition, sampleOf, type ReadPage } from '../../testing/exposition';
import { jobFamilies, jobMetrics, type JobRun } from './metrics';

const KNOWN = ['sweep:sessions', 'purge:retention', 'sweep:orphans'] as const;

const pageOf = (families: Parameters<typeof exposition>[0]): ReadPage =>
  readExposition(exposition(families));

const RUNS: readonly JobRun[] = [
  {
    job_name: 'sweep:sessions',
    last_success_at: new Date('2026-10-31T09:15:00.000Z'),
    consecutive_failures: 0,
  },
  {
    job_name: 'purge:retention',
    last_success_at: new Date('2026-10-29T02:30:00.000Z'),
    consecutive_failures: 2,
  },
  // A job since retired: its row stays, its series do not.
  { job_name: 'sweep:retired', last_success_at: new Date(0), consecutive_failures: 9 },
];

describe('the scheduled jobs on the page', () => {
  test('say when each last succeeded and how often it has failed since, by the name it is planned as', () => {
    const page = pageOf(jobFamilies(KNOWN, RUNS));
    expect(sampleOf(page, 'purlay_jobs_status_readable')).toBe(1);
    expect(
      sampleOf(page, 'purlay_job_last_success_timestamp_seconds', { job: 'sweep:sessions' }),
    ).toBe(Date.parse('2026-10-31T09:15:00.000Z') / 1000);
    expect(sampleOf(page, 'purlay_job_consecutive_failures', { job: 'purge:retention' })).toBe(2);
    expect(sampleOf(page, 'purlay_job_consecutive_failures', { job: 'sweep:sessions' })).toBe(0);
  });

  test('a job that never ran has no last success, and no failures counted', () => {
    const page = pageOf(jobFamilies(KNOWN, RUNS));
    expect(
      sampleOf(page, 'purlay_job_last_success_timestamp_seconds', { job: 'sweep:orphans' }),
    ).toBeUndefined();
    expect(sampleOf(page, 'purlay_job_consecutive_failures', { job: 'sweep:orphans' })).toBe(0);
  });

  test('a row for a job the plan does not name adds no series', () => {
    const page = pageOf(jobFamilies(KNOWN, RUNS));
    expect(page.samples.filter((sample) => sample.labels['job'] === 'sweep:retired')).toEqual([]);
    const jobs = new Set(page.samples.flatMap((sample) => sample.labels['job'] ?? []));
    expect([...jobs].sort()).toEqual([...KNOWN].sort());
  });

  test('a record that could not be read is said as 0, with no job series that would look current', () => {
    const page = pageOf(jobFamilies(KNOWN, undefined));
    expect(sampleOf(page, 'purlay_jobs_status_readable')).toBe(0);
    expect(page.samples).toHaveLength(1);
  });
});

describe('reading the record for a scrape', () => {
  test('a failing read leaves the rest of the page, and is logged once until it reads again', async () => {
    const { log, lines } = aRecordingLogger();
    let failing = true;
    const read = jobMetrics({
      known: KNOWN,
      log,
      read: async () => {
        if (failing) throw new Error('connection refused');
        return await Promise.resolve(RUNS);
      },
    });
    for (let scrape = 0; scrape < 3; scrape += 1) {
      expect(sampleOf(pageOf(await read()), 'purlay_jobs_status_readable')).toBe(0);
    }
    const said = (): number =>
      lines.filter(
        (line) => line['msg'] === 'the scheduled jobs’ record could not be read for metrics',
      ).length;
    expect(said()).toBe(1);
    failing = false;
    expect(sampleOf(pageOf(await read()), 'purlay_jobs_status_readable')).toBe(1);
    // Failing again after it recovered is news again.
    failing = true;
    await read();
    expect(said()).toBe(2);
  });

  /** A database that accepts the query and never answers must not hold the scrape until Prometheus gives up. */
  test('a read that does not answer in time is given up, and the page is answered without it', async () => {
    const { log, lines } = aRecordingLogger();
    const read = jobMetrics({
      known: KNOWN,
      log,
      timeoutMs: 20,
      read: async () => await new Promise<readonly JobRun[]>(() => undefined),
    });
    const started = performance.now();
    const families = await read();
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(sampleOf(pageOf(families), 'purlay_jobs_status_readable')).toBe(0);
    expect(JSON.stringify(lines[0])).toContain('no answer within 20 ms');
  });
});
