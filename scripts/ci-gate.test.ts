/** The required `verify` check: passes only when every job it stands for succeeded. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GATED, judge, main } from './ci-gate';

const results = (static_: string, schema: string): string =>
  JSON.stringify({
    static: { result: static_, outputs: {} },
    schema: { result: schema, outputs: {} },
  });

describe('the gate', () => {
  test('passes when the static checks and the whole test suite succeeded', () => {
    expect(judge(results('success', 'success'))).toEqual([]);
  });

  const outcomes = ['failure', 'cancelled', 'skipped', ''] as const;
  for (const job of GATED) {
    for (const outcome of outcomes) {
      test(`refuses when ${job} ended ${outcome === '' ? 'with no result' : outcome}`, () => {
        const both = job === 'static' ? results(outcome, 'success') : results('success', outcome);
        expect(judge(both)).toEqual([
          `${job} ended ${outcome === '' ? 'with no result' : outcome}`,
        ]);
      });
    }
  }

  test('names every job that did not succeed, not only the first', () => {
    expect(judge(results('failure', 'cancelled'))).toEqual([
      'static ended failure',
      'schema ended cancelled',
    ]);
  });

  test('refuses when a job it stands for is missing from what it was handed', () => {
    expect(judge(JSON.stringify({ static: { result: 'success' } }))).toEqual([
      'schema is not among the jobs this one needs',
    ]);
  });

  test('refuses a job it does not stand for, so the two lists cannot drift apart quietly', () => {
    const extra = {
      ...(JSON.parse(results('success', 'success')) as object),
      browser: { result: 'success' },
    };
    expect(judge(JSON.stringify(extra))).toEqual([
      'browser is needed but the gate does not judge it',
    ]);
  });

  test.each(['', 'null', '[]', '"success"', '{', '{}'])('refuses %p as the results', (text) => {
    expect(judge(text).length).toBeGreaterThan(0);
  });
});

/** What GitHub reads is the exit code, not the reasons: it is tested as the job runs it. */
describe('the command', () => {
  test('returns 0 only for two successes, and 1 for anything else or nothing', () => {
    expect(main({ NEEDS: results('success', 'success') })).toBe(0);
    expect(main({ NEEDS: results('success', 'skipped') })).toBe(1);
    expect(main({})).toBe(1);
  });

  const exitOf = (needs: string | undefined): number =>
    Bun.spawnSync(['bun', '--no-env-file', 'scripts/ci-gate.ts'], {
      env: { PATH: process.env['PATH'] ?? '', ...(needs === undefined ? {} : { NEEDS: needs }) },
    }).exitCode;

  test('exits 1 as a process on a failure, a skip and no results, and 0 on two successes', () => {
    expect(exitOf(results('failure', 'success'))).toBe(1);
    expect(exitOf(results('success', 'skipped'))).toBe(1);
    expect(exitOf(undefined)).toBe(1);
    expect(exitOf(results('success', 'success'))).toBe(0);
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
