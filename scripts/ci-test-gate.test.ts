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
  });
});
