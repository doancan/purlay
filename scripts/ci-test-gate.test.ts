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
  // The suite runs as areas side by side, `schema-area`, and `schema` puts them together (D-340). What was true of the
  // one job is true of each area, and of the whole: the same two reasons to skip, and no other.
  const SKIPPED_FOR_TWO_REASONS =
    "needs.scope.outputs.light != 'true' && needs.scope.outputs.reuse != 'true'";

  test('its areas are skipped for exactly two reasons, and for no other: a light change, and content a pull request already ran it on (D-332)', () => {
    const areas = workflow.jobs['schema-area'];
    expect(areas).toBeDefined();
    // The only prerequisite is the job that says which of the two applies, and the only condition is those two.
    // Any other `if` or `needs` — a path, a label, an actor — is a way for the whole suite not to run.
    expect(areas?.needs).toBe('scope');
    expect(areas?.if).toBe(SKIPPED_FOR_TWO_REASONS);
    // The services' addresses are declared once for the job, for the areas that have services.
    expect(areas?.env?.['DATABASE_URL']).toBeTruthy();
    expect(areas?.env?.['REDIS_URL']).toBeTruthy();
  });

  test('the whole, `schema`, is skipped for exactly the same two reasons, and runs whatever became of its areas', () => {
    const schema = workflow.jobs['schema'];
    expect(schema).toBeDefined();
    // `always()` is what lets it say that an area failed or never ran; the two reasons are still the only way to skip.
    expect(schema?.needs).toEqual(['scope', 'schema-area']);
    expect(schema?.if).toBe(`always() && ${SKIPPED_FOR_TWO_REASONS}`);
  });

  test('cannot conditionally skip the complete suite or ignore its failure', () => {
    const tests =
      workflow.jobs['schema-area']?.steps.filter((step) => step.run === 'bun run test:all') ?? [];
    expect(tests).toHaveLength(1);
    expect(tests[0]?.if).toBeUndefined();
    expect(tests[0]?.['continue-on-error']).not.toBe(true);
    const floor =
      workflow.jobs['schema']?.steps.filter((step) => step.run === 'bun run coverage:floor') ?? [];
    expect(floor).toHaveLength(1);
    expect(floor[0]?.if).toBeUndefined();
    expect(floor[0]?.['continue-on-error']).not.toBe(true);
  });
});

describe('the light suite (D-332)', () => {
  const job = workflow.jobs['light-suite'];
  const scripts = (
    JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }
  ).scripts;

  test('runs for a light change and only then, and cannot skip a step or ignore a failure', () => {
    expect(job?.needs).toBe('scope');
    expect(job?.if).toBe("needs.scope.outputs.light == 'true'");
    const runs = job?.steps.filter((step) => step.run === 'bun run test:light') ?? [];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.if).toBeUndefined();
    expect(runs[0]?.['continue-on-error']).not.toBe(true);
  });

  test('runs every test of every root that needs no database, so every test that can read a document or the version', () => {
    const command = scripts['test:light'] ?? '';
    for (const root of ['apps', 'packages', 'scripts']) expect(command).toContain(` ${root}`);
    // What it leaves out is the integration tests and nothing else: no directory, no file, no name.
    expect(command.match(/--path-ignore-patterns/g)).toHaveLength(1);
    expect(command).toContain("--path-ignore-patterns '**/*.integration.test.ts'");
  });

  test('is one of the jobs the required check stands for', () => {
    expect(workflow.jobs['verify']?.needs).toContain('light-suite');
    expect(workflow.jobs['verify']?.needs).toContain('scope');
  });
});

describe('the static checks', () => {
  test('are skipped for one reason only: content a pull request already ran them on (D-332)', () => {
    expect(workflow.jobs['static']?.needs).toBe('scope');
    expect(workflow.jobs['static']?.if).toBe("needs.scope.outputs.reuse != 'true'");
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
    expect(job?.needs).toEqual(['changes', 'scope']);
    expect(job?.if).toBe(
      "needs.changes.outputs.modules == 'true' && needs.scope.outputs.reuse != 'true'",
    );
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
