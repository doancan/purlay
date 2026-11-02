/** The required `verify` check: passes only when every job it stands for succeeded (D-203, D-226). */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GATED, judge, main } from './ci-gate';

type Job = (typeof GATED)[number];

/**
 * What `toJSON(needs)` hands the gate: every job succeeded and the change touched what the browser
 * jobs see, unless said otherwise.
 */
const results = (over: Partial<Record<Job, string>> = {}, touched = 'true'): string =>
  JSON.stringify({
    static: { result: over.static ?? 'success', outputs: {} },
    schema: { result: over.schema ?? 'success', outputs: {} },
    changes: { result: over.changes ?? 'success', outputs: { browser: touched } },
    browser: { result: over.browser ?? 'success', outputs: {} },
  });

describe('the gate', () => {
  test('passes when the static checks, the whole suite and the browser jobs succeeded', () => {
    expect(judge(results())).toEqual([]);
  });

  test('passes a change the browser jobs cannot see, whose browser jobs were skipped for it', () => {
    expect(judge(results({ browser: 'skipped' }, 'false'))).toEqual([]);
  });

  test('refuses skipped browser jobs for a change they can see', () => {
    expect(judge(results({ browser: 'skipped' }, 'true'))).toEqual(['browser ended skipped']);
  });

  test('refuses skipped browser jobs when it cannot tell whether the change needed them', () => {
    expect(judge(results({ changes: 'failure', browser: 'skipped' }, ''))).toEqual([
      'changes ended failure',
      'browser ended skipped',
    ]);
    expect(judge(results({ browser: 'skipped' }, ''))).toEqual(['browser ended skipped']);
    // A changes job that failed may still have said "false" before it did: its word does not count.
    expect(judge(results({ changes: 'failure', browser: 'skipped' }, 'false'))).toEqual([
      'changes ended failure',
      'browser ended skipped',
    ]);
  });

  test('refuses failed browser jobs, whatever the change touched', () => {
    expect(judge(results({ browser: 'failure' }, 'false'))).toEqual(['browser ended failure']);
  });

  const outcomes = ['failure', 'cancelled', 'skipped', ''] as const;
  for (const job of GATED) {
    for (const outcome of outcomes) {
      test(`refuses when ${job} ended ${outcome === '' ? 'with no result' : outcome}`, () => {
        expect(judge(results({ [job]: outcome }))).toEqual([
          `${job} ended ${outcome === '' ? 'with no result' : outcome}`,
        ]);
      });
    }
  }

  test('names every job that did not succeed, not only the first', () => {
    expect(judge(results({ static: 'failure', schema: 'cancelled', browser: 'failure' }))).toEqual([
      'static ended failure',
      'schema ended cancelled',
      'browser ended failure',
    ]);
  });

  test('refuses when a job it stands for is missing from what it was handed', () => {
    const handed = JSON.parse(results()) as Record<string, unknown>;
    delete handed['browser'];
    expect(judge(JSON.stringify(handed))).toEqual(['browser is not among the jobs this one needs']);
  });

  test('refuses a job it does not stand for, so the two lists cannot drift apart quietly', () => {
    const extra = { ...(JSON.parse(results()) as object), rehearse: { result: 'success' } };
    expect(judge(JSON.stringify(extra))).toEqual([
      'rehearse is needed but the gate does not judge it',
    ]);
  });

  test.each(['', 'null', '[]', '"success"', '{', '{}'])('refuses %p as the results', (text) => {
    expect(judge(text).length).toBeGreaterThan(0);
  });
});

/** What GitHub reads is the exit code, not the reasons: it is tested as the job runs it. */
describe('the command', () => {
  test('returns 0 only for a verdict that passes, and 1 for anything else or nothing', () => {
    expect(main({ NEEDS: results() })).toBe(0);
    expect(main({ NEEDS: results({ browser: 'skipped' }, 'false') })).toBe(0);
    expect(main({ NEEDS: results({ schema: 'skipped' }) })).toBe(1);
    expect(main({ NEEDS: results({ browser: 'skipped' }) })).toBe(1);
    expect(main({})).toBe(1);
  });

  const exitOf = (needs: string | undefined): number =>
    Bun.spawnSync(['bun', '--no-env-file', 'scripts/ci-gate.ts'], {
      env: { PATH: process.env['PATH'] ?? '', ...(needs === undefined ? {} : { NEEDS: needs }) },
    }).exitCode;

  test('exits 1 as a process on a failure, a skip and no results, and 0 on a pass', () => {
    expect(exitOf(results({ static: 'failure' }))).toBe(1);
    expect(exitOf(results({ browser: 'skipped' }))).toBe(1);
    expect(exitOf(undefined)).toBe(1);
    expect(exitOf(results())).toBe(0);
  });
});

/**
 * The workflow half. The gate is only fail-closed if the job that runs it runs whatever happened
 * before it: a job whose dependency failed is skipped by default, and branch protection counts a
 * skipped required check as passed.
 */
describe('the verify job in ci.yml', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const job = /^ {2}verify:\n([\s\S]*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/m.exec(workflow)?.[1] ?? '';

  test('exists', () => {
    expect(job).not.toBe('');
  });

  test('needs exactly the jobs the gate judges', () => {
    const needs = /^ {4}needs: \[([^\]]*)\]$/m
      .exec(job)?.[1]
      ?.split(',')
      .map((name) => name.trim());
    expect(needs).toEqual([...GATED]);
  });

  test('runs even when a job it needs failed, was cancelled or was skipped', () => {
    expect(job).toMatch(/^ {4}if: always\(\)$/m);
  });

  // A job or step that may fail and still succeed would make the verdict, or a job it judges, a formality.
  test('nothing it judges or runs may fail and still succeed', () => {
    for (const name of ['verify', ...GATED]) {
      const block =
        new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[\\w-]+:\\n|(?![\\s\\S]))`, 'm').exec(
          workflow,
        )?.[1] ?? '';
      expect(block).not.toBe('');
      expect(block).not.toContain('continue-on-error');
    }
    expect(job.match(/^\s+if:/gm)).toHaveLength(1);
  });

  test('hands the gate the results of what it needs', () => {
    expect(job).toContain('NEEDS: ${{ toJSON(needs) }}');
    expect(job).toMatch(/run: bun run ci:gate$/m);
  });

  test('the jobs it judges are jobs the workflow defines', () => {
    for (const name of GATED) expect(workflow).toMatch(new RegExp(`^ {2}${name}:$`, 'm'));
  });

  test('the whole suite runs in schema and nowhere else, once', () => {
    expect(workflow.match(/run: bun run test:all$/gm)).toHaveLength(1);
    expect(workflow).not.toMatch(/run: bun run test$/m);
  });

  test('the test services start together, each waited on until healthy', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts['db:up:tests']).toBe('docker compose up -d --wait postgres redis');
    expect(workflow).toMatch(/run: bun run db:up:tests$/m);
    const compose = readFileSync('docker-compose.yml', 'utf8');
    for (const service of ['postgres', 'redis']) {
      const block = new RegExp(
        `^ {2}${service}:\\n([\\s\\S]*?)(?=^ {2}\\w|(?![\\s\\S]))`,
        'm',
      ).exec(compose)?.[1];
      expect(block).toContain('healthcheck:');
    }
  });
});
