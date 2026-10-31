/**
 * The browser budgets are measured alone (D-227): the files that write a measurement run apart from
 * the rest of the suite, on one worker, so another test does not compete for the runner while they
 * measure — and the pipeline does exactly that, then lets `budget:browser` measure a regression again.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

/** The test files Playwright would run for one project with this `PURLAY_E2E_PERFORMANCE`. */
const listed = (mode: string): { readonly files: readonly string[]; readonly output: string } => {
  const result = Bun.spawnSync(['bun', 'x', 'playwright', 'test', '--list'], {
    cwd: 'apps/web',
    env: { ...process.env, PURLAY_E2E_PROJECT: 'chromium-light', PURLAY_E2E_PERFORMANCE: mode },
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  const files = [...output.matchAll(/› (\S+\.e2e\.ts):/g)].map((match) => match[1] ?? '');
  return { files: [...new Set(files)].sort(), output };
};

const MEASURING = ['feed-scale.e2e.ts', 'performance.e2e.ts'];
// Listing starts Playwright and reads every spec; a second and a half here, more on a busy runner.
const LISTING_MS = 30_000;

describe('PURLAY_E2E_PERFORMANCE', () => {
  test(
    'only runs the files that write a measurement, and nothing else',
    () => {
      expect(listed('only').files).toEqual(MEASURING);
    },
    LISTING_MS,
  );

  test(
    'skip runs everything but them, and unset runs everything',
    () => {
      const skipped = listed('skip').files;
      const everything = listed('').files;
      expect(skipped.length).toBeGreaterThan(10);
      expect(skipped.filter((file) => MEASURING.includes(file))).toEqual([]);
      expect(everything).toEqual([...skipped, ...MEASURING].sort());
    },
    LISTING_MS,
  );

  test(
    'refuses a value it does not take, rather than running everything',
    () => {
      const { files, output } = listed('alone');
      expect(files).toEqual([]);
      expect(output).toContain('PURLAY_E2E_PERFORMANCE is alone');
    },
    LISTING_MS,
  );
});

interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
}
const workflow = Bun.YAML.parse(readFileSync('.github/workflows/ci.yml', 'utf8')) as {
  jobs: Record<string, { steps: Step[] }>;
};

describe('the browser job', () => {
  const steps = workflow.jobs['browser']?.steps ?? [];
  const at = (found: (step: Step) => boolean): number => steps.findIndex(found);
  const suite = at((step) => step.run === 'bun run test:e2e');
  const alone = at((step) => step.run === 'bun run test:e2e -- --workers=1');
  const budget = at((step) => step.run?.startsWith('bun run budget:browser') === true);

  test('runs the suite without the measurements, then the measurements alone on one worker', () => {
    expect(suite).toBeGreaterThan(-1);
    expect(steps[suite]?.env?.['PURLAY_E2E_PERFORMANCE']).toBe('skip');
    expect(alone).toBeGreaterThan(suite);
    expect(steps[alone]?.env?.['PURLAY_E2E_PERFORMANCE']).toBe('only');
    expect(steps[alone]?.env?.['PURLAY_E2E_PROJECT']).toBe(
      steps[suite]?.env?.['PURLAY_E2E_PROJECT'],
    );
  });

  test('judges what was measured alone, and measures a regression again', () => {
    expect(budget).toBeGreaterThan(alone);
    expect(steps[budget]?.run).toContain('--remeasure');
  });
});
