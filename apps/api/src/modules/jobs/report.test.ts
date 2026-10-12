/**
 * `jobs:status` (D-30): what each job last did, and whether any is overdue — a job that never ran is
 * the cron nobody installed, and it must look like a problem, not like an empty table.
 */
import { describe, expect, test } from 'bun:test';
import { STALE_AFTER_MS, jobReport, neverSucceeded } from './report';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('the job report', () => {
  test('a job that succeeded lately is well; one that never ran, or not lately, is overdue', () => {
    const report = jobReport(
      ['sweep:orphans', 'sweep:sessions', 'reconcile:storage'],
      [
        {
          job_name: 'sweep:orphans',
          last_success_at: ago(60_000),
          consecutive_failures: 0,
          last_error: null,
        },
        {
          job_name: 'reconcile:storage',
          last_success_at: ago(STALE_AFTER_MS + 1),
          consecutive_failures: 3,
          last_error: 'the bucket is down',
        },
      ],
      NOW,
    );
    expect(report.healthy).toBe(false);
    expect(report.lines).toEqual([
      'ok       sweep:orphans      last success 2026-09-09T11:59:00.000Z',
      'never    sweep:sessions     has never succeeded: is the scheduler installed?',
      'overdue  reconcile:storage  last success 2026-09-07T11:59:59.999Z, 3 failures since: the bucket is down',
    ]);
  });

  test('a job that has not failed but has not run for two days is overdue: the scheduler stopped', () => {
    const report = jobReport(
      ['sweep:orphans'],
      [
        {
          job_name: 'sweep:orphans',
          last_success_at: ago(STALE_AFTER_MS + 1),
          consecutive_failures: 0,
          last_error: null,
        },
      ],
      NOW,
    );
    expect(report.healthy).toBe(false);
    expect(report.lines).toEqual(['overdue  sweep:orphans  last success 2026-09-07T11:59:59.999Z']);
  });

  test('every job well is healthy', () => {
    const report = jobReport(
      ['sweep:orphans'],
      [
        {
          job_name: 'sweep:orphans',
          last_success_at: ago(0),
          consecutive_failures: 0,
          last_error: null,
        },
      ],
      NOW,
    );
    expect(report.healthy).toBe(true);
  });

  test('a job well on time but failing since is still said, with its failures', () => {
    const report = jobReport(
      ['sweep:orphans'],
      [
        {
          job_name: 'sweep:orphans',
          last_success_at: ago(60_000),
          consecutive_failures: 1,
          last_error: 'timeout',
        },
      ],
      NOW,
    );
    expect(report.healthy).toBe(false);
    expect(report.lines[0]).toContain('1 failure since: timeout');
  });
});

describe('what a new deployment has never run', () => {
  test('the jobs with no success yet, in the plan’s order; a failing one with no success counts', () => {
    const never = neverSucceeded(
      ['sweep:sessions', 'sweep:orphans', 'reconcile:storage', 'sweep:link-previews'],
      [
        {
          job_name: 'sweep:orphans',
          last_success_at: ago(STALE_AFTER_MS * 10),
          consecutive_failures: 2,
          last_error: 'down',
        },
        {
          job_name: 'reconcile:storage',
          last_success_at: null,
          consecutive_failures: 1,
          last_error: 'down',
        },
      ],
    );
    expect(never).toEqual(['sweep:sessions', 'reconcile:storage', 'sweep:link-previews']);
  });

  test('a deployment where every job has succeeded once has nothing to catch up', () => {
    expect(
      neverSucceeded(
        ['sweep:orphans'],
        [
          {
            job_name: 'sweep:orphans',
            last_success_at: ago(1),
            consecutive_failures: 0,
            last_error: null,
          },
        ],
      ),
    ).toEqual([]);
  });
});
