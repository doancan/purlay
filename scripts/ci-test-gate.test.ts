/** The complete coverage suite remains unconditional after removing the duplicate unit run (D-203). */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

interface Step {
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
}
interface Job {
  if?: string;
  needs?: unknown;
  env?: Record<string, string>;
  steps: Step[];
}
const workflow = Bun.YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, Job>;
};

describe('the complete CI coverage suite', () => {
  test('runs independently, without a job-level condition or prerequisite that could skip it', () => {
    const schema = workflow.jobs['schema'];
    expect(schema).toBeDefined();
    expect(schema?.if).toBeUndefined();
    expect(schema?.needs).toBeUndefined();
    expect(schema?.env?.['DATABASE_URL']).toBeTruthy();
    expect(schema?.env?.['REDIS_URL']).toBeTruthy();
  });

  test('cannot conditionally skip the complete suite or ignore its failure', () => {
    const tests =
      workflow.jobs['schema']?.steps.filter((step) => step.run === 'bun run test:all') ?? [];
    expect(tests).toHaveLength(1);
    expect(tests[0]?.if).toBeUndefined();
    expect(tests[0]?.['continue-on-error']).not.toBe(true);
  });
});

describe('the module matrix job', () => {
  const job = workflow.jobs['modules'];

  test('runs the smoke on a database of its own and only when the change can move an answer', () => {
    expect(job?.needs).toBe('changes');
    expect(job?.if).toBe("needs.changes.outputs.modules == 'true'");
    expect(job?.env?.['DATABASE_URL']).toBeTruthy();
    expect(job?.steps.filter((step) => step.run === 'bun run modules:smoke')).toHaveLength(1);
  });

  test('names a script the repository has, under the name the workflow runs', () => {
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(scripts['modules:smoke']).toContain('apps/api/src/testing/module-smoke.ts');
    expect(scripts['modules:suites']).toContain('apps/api/src/testing/module-suites.ts');
  });
});

describe('the suites-per-cell job', () => {
  const job = workflow.jobs['module-suites'] as
    (Job & { strategy?: { 'fail-fast'?: boolean; matrix?: { cell?: string[] } } }) | undefined;

  test('runs when the change can move an answer, with Redis, a leg for each cell, and cannot skip or ignore a failure', () => {
    expect(job?.needs).toBe('changes');
    expect(job?.if).toBe("needs.changes.outputs.modules == 'true'");
    expect(job?.env?.['REDIS_URL']).toBeTruthy();
    expect(job?.strategy?.['fail-fast']).toBe(false);
    const runs = job?.steps.filter((step) => step.run?.startsWith('bun run modules:suites')) ?? [];
    expect(runs.map((step) => step.run)).toEqual(['bun run modules:suites -- ${{ matrix.cell }}']);
    expect(runs[0]?.if).toBeUndefined();
    expect(runs[0]?.['continue-on-error']).not.toBe(true);
    expect(job?.steps.some((step) => step.run === 'bun run db:up:tests')).toBe(true);
  });

  test('is one of the jobs the required check stands for', () => {
    expect(workflow.jobs['verify']?.needs).toContain('module-suites');
  });
});
