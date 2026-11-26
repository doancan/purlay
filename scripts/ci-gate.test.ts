/** The required `verify` check: passes only when every job it stands for succeeded (D-203, D-226). */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { GATED, judge, main } from './ci-gate';
import { AREAS, needsServices } from './test-area';

type Job = (typeof GATED)[number];

/**
 * What `toJSON(needs)` hands the gate: every job succeeded and the change touched what the browser
 * jobs see, unless said otherwise.
 */
const results = (
  over: Partial<Record<Job, string>> = {},
  touched = 'true',
  touchedModules = 'true',
  touchedMutations = 'true',
  scoped: { light: string; reuse: string } = { light: 'false', reuse: 'false' },
): string =>
  JSON.stringify({
    scope: { result: over.scope ?? 'success', outputs: scoped },
    static: { result: over.static ?? 'success', outputs: {} },
    schema: { result: over.schema ?? 'success', outputs: {} },
    // The areas of `schema` are skipped for the very reasons it is: they follow it there, and are their own result otherwise.
    'schema-area': {
      result: over['schema-area'] ?? (over.schema === 'skipped' ? 'skipped' : 'success'),
      outputs: {},
    },
    // Run only for a light change: skipped is its ordinary state, and right while `scope` says the change was not.
    'light-suite': { result: over['light-suite'] ?? 'skipped', outputs: {} },
    'api-measurements': { result: over['api-measurements'] ?? 'success', outputs: {} },
    changes: {
      result: over.changes ?? 'success',
      outputs: { browser: touched, modules: touchedModules, mutations: touchedMutations },
    },
    browser: { result: over.browser ?? 'success', outputs: {} },
    modules: { result: over.modules ?? 'success', outputs: {} },
    'module-suites': { result: over['module-suites'] ?? 'success', outputs: {} },
    'cohort-measurements': { result: over['cohort-measurements'] ?? 'success', outputs: {} },
    'mutations-changed': { result: over['mutations-changed'] ?? 'success', outputs: {} },
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

  test('passes a change the modules job cannot see, which was skipped for it', () => {
    expect(judge(results({ modules: 'skipped' }, 'true', 'false'))).toEqual([]);
  });

  test('refuses a skipped modules job for a change it can see, and one whose reason is only the browser’s', () => {
    expect(judge(results({ modules: 'skipped' }, 'true', 'true'))).toEqual([
      'modules ended skipped',
    ]);
    expect(judge(results({ modules: 'skipped' }, 'false', 'true'))).toEqual([
      'modules ended skipped',
    ]);
  });

  test('passes a change the modules jobs cannot see, whose suites per cell were skipped for it, and refuses them for one they can', () => {
    expect(judge(results({ 'module-suites': 'skipped' }, 'true', 'false'))).toEqual([]);
    expect(judge(results({ 'module-suites': 'skipped' }, 'true', 'true'))).toEqual([
      'module-suites ended skipped',
    ]);
    expect(judge(results({ 'module-suites': 'failure' }, 'true', 'false'))).toEqual([
      'module-suites ended failure',
    ]);
  });

  test('permits the cohort measurement skip only for a successful explicit modules=false decision', () => {
    expect(judge(results({ 'cohort-measurements': 'skipped' }, 'true', 'false'))).toEqual([]);
    expect(judge(results({ 'cohort-measurements': 'skipped' }, 'false', 'true'))).toEqual([
      'cohort-measurements ended skipped',
    ]);
    expect(judge(results({ 'cohort-measurements': 'skipped' }, 'true', ''))).toEqual([
      'cohort-measurements ended skipped',
    ]);
    expect(
      judge(results({ changes: 'failure', 'cohort-measurements': 'skipped' }, 'true', 'false')),
    ).toEqual(['changes ended failure', 'cohort-measurements ended skipped']);
  });

  test('passes a change that touches no mutation file, whose mutations job was skipped for it, and refuses the skip for one that does', () => {
    expect(judge(results({ 'mutations-changed': 'skipped' }, 'true', 'true', 'false'))).toEqual([]);
    expect(judge(results({ 'mutations-changed': 'skipped' }, 'true', 'true', 'true'))).toEqual([
      'mutations-changed ended skipped',
    ]);
  });

  test('refuses a skipped mutations job when only another job’s reason says it is not needed, or when it cannot tell', () => {
    expect(judge(results({ 'mutations-changed': 'skipped' }, 'false', 'false', 'true'))).toEqual([
      'mutations-changed ended skipped',
    ]);
    expect(
      judge(results({ changes: 'failure', 'mutations-changed': 'skipped' }, '', '', '')),
    ).toEqual(['changes ended failure', 'mutations-changed ended skipped']);
  });

  test('refuses a failed mutations job, even for a change that touches no mutation file', () => {
    expect(judge(results({ 'mutations-changed': 'failure' }, 'true', 'true', 'false'))).toEqual([
      'mutations-changed ended failure',
    ]);
  });

  test('refuses a failed modules job, whatever the change touched', () => {
    expect(judge(results({ modules: 'failure' }, 'false', 'false'))).toEqual([
      'modules ended failure',
    ]);
  });

  test('refuses failed browser jobs, whatever the change touched', () => {
    expect(judge(results({ browser: 'failure' }, 'false'))).toEqual(['browser ended failure']);
  });

  const outcomes = ['failure', 'cancelled', 'skipped', ''] as const;
  for (const job of GATED) {
    for (const outcome of outcomes) {
      // Skipped is how `light-suite` ordinarily ends, for a change that was not light.
      if (job === 'light-suite' && outcome === 'skipped') continue;
      test(`refuses when ${job} ended ${outcome === '' ? 'with no result' : outcome}`, () => {
        const ended = `${job} ended ${outcome === '' ? 'with no result' : outcome}`;
        // Without a `scope` that succeeded, the light suite's ordinary skip cannot be told from a missing one.
        // A skipped `schema` takes its areas with it, which is the reason they are skipped too: both are refused.
        const alongside =
          job === 'scope'
            ? ['light-suite ended skipped']
            : job === 'schema' && outcome === 'skipped'
              ? ['schema-area ended skipped']
              : [];
        expect(judge(results({ [job]: outcome }))).toEqual([ended, ...alongside]);
      });
    }
  }

  const light = { light: 'true', reuse: 'false' };
  const reused = { light: 'false', reuse: 'true' };

  test('passes a light change whose coverage run was skipped for the light suite, which succeeded', () => {
    expect(
      judge(
        results({ schema: 'skipped', 'light-suite': 'success' }, 'false', 'false', 'false', light),
      ),
    ).toEqual([]);
  });

  test('refuses a light change whose light suite did not succeed, or was itself skipped', () => {
    for (const outcome of ['failure', 'cancelled', 'skipped', '']) {
      expect(
        judge(
          results({ schema: 'skipped', 'light-suite': outcome }, 'false', 'false', 'false', light),
        ),
      ).toEqual([`light-suite ended ${outcome === '' ? 'with no result' : outcome}`]);
    }
  });

  test('refuses the coverage run skipped for a change that was not light and whose content was not verified', () => {
    expect(judge(results({ schema: 'skipped', 'light-suite': 'success' }))).toEqual([
      'schema ended skipped',
      'schema-area ended skipped',
    ]);
  });

  test('refuses the coverage run skipped when `scope` itself did not succeed, whatever it said', () => {
    expect(
      judge(
        results(
          { scope: 'failure', schema: 'skipped', 'light-suite': 'success' },
          'false',
          'false',
          'false',
          light,
        ),
      ),
    ).toEqual(['scope ended failure', 'schema ended skipped', 'schema-area ended skipped']);
  });

  test('passes content already verified, whose static, coverage and per-cell suites were skipped for it', () => {
    expect(
      judge(
        results(
          { static: 'skipped', schema: 'skipped', 'module-suites': 'skipped' },
          'true',
          'true',
          'true',
          reused,
        ),
      ),
    ).toEqual([]);
  });

  test('refuses what content already verified does not excuse: the browser jobs, the modules job, the measurements', () => {
    for (const job of ['browser', 'modules', 'api-measurements', 'mutations-changed'] as const) {
      expect(judge(results({ [job]: 'skipped' }, 'true', 'true', 'true', reused))).toEqual([
        `${job} ended skipped`,
      ]);
    }
  });

  test('refuses the heavy jobs skipped on a commit whose content was not said to be verified', () => {
    expect(
      judge(results({ static: 'skipped', schema: 'skipped', 'module-suites': 'skipped' })),
    ).toEqual([
      'static ended skipped',
      'schema ended skipped',
      'schema-area ended skipped',
      'module-suites ended skipped',
    ]);
  });

  test('names every job that did not succeed, not only the first', () => {
    expect(judge(results({ static: 'failure', schema: 'cancelled', browser: 'failure' }))).toEqual([
      'static ended failure',
      'schema ended cancelled',
      'browser ended failure',
    ]);
  });

  test('refuses an area of the suite that failed or never ran, whatever `schema` said', () => {
    expect(judge(results({ 'schema-area': 'failure' }))).toEqual(['schema-area ended failure']);
    expect(judge(results({ 'schema-area': 'cancelled' }))).toEqual(['schema-area ended cancelled']);
    expect(judge(results({ 'schema-area': 'skipped' }))).toEqual(['schema-area ended skipped']);
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
    const parsed = Bun.YAML.parse(workflow) as { jobs: { verify: { needs: unknown } } };
    const needs = parsed.jobs.verify.needs;
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

  test('the mutations job is skipped by the output of `changes` the gate reads, and by nothing else', () => {
    const mutations =
      /^ {2}mutations-changed:\n([\s\S]*?)(?=^ {2}[\w-]+:\n|(?![\s\S]))/m.exec(workflow)?.[1] ?? '';
    expect(mutations).toMatch(/^ {4}needs: changes$/m);
    expect(mutations).toMatch(/^ {4}if: needs\.changes\.outputs\.mutations == 'true'$/m);
    expect(workflow).toContain('mutations: ${{ steps.paths.outputs.mutations }}');
  });

  test('hands the gate the results of what it needs', () => {
    expect(job).toContain('NEEDS: ${{ toJSON(needs) }}');
    expect(job).toMatch(/run: bun run ci:gate$/m);
  });

  test('the jobs it judges are jobs the workflow defines', () => {
    for (const name of GATED) expect(workflow).toMatch(new RegExp(`^ {2}${name}:$`, 'm'));
  });

  test('the whole suite runs in the areas of schema-area and nowhere else, once', () => {
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

/**
 * The suite runs as areas, side by side, and `schema` puts them together (D-341). Branch protection requires `schema`
 * and `verify` by name, so what they mean is held here: the areas are every area, `schema` fails unless every area
 * passed, and both are skipped for exactly the reasons the whole suite was.
 */
describe('the suite in areas, in ci.yml', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  interface WorkflowJob {
    needs?: unknown;
    if?: string;
    strategy?: { 'fail-fast'?: boolean; matrix?: { area?: string[] } };
    env?: Record<string, string>;
    steps?: {
      name?: string;
      if?: string;
      run?: string;
      uses?: string;
      with?: Record<string, unknown>;
      env?: Record<string, string>;
    }[];
  }
  const jobs = (Bun.YAML.parse(workflow) as { jobs: Record<string, WorkflowJob> }).jobs;
  const areas = jobs['schema-area'];
  const schema = jobs['schema'];
  const notSkipped = "needs.scope.outputs.light != 'true' && needs.scope.outputs.reuse != 'true'";

  test('every area is skipped for the reasons the whole was, and for no other', () => {
    expect(areas?.needs).toBe('scope');
    expect(areas?.if).toBe(notSkipped);
  });

  test('there is one job per area the repository names, each told which it is, and a failed one does not hide the rest', () => {
    expect(areas?.strategy?.matrix?.area).toEqual([...AREAS]);
    expect(areas?.strategy?.['fail-fast']).toBe(false);
    expect(areas?.env?.['PURLAY_TEST_AREA']).toBe('${{ matrix.area }}');
  });

  test('only the areas that need services start them, and the web area is given no database', () => {
    const steps = areas?.steps ?? [];
    for (const command of ['bun run db:up:tests', 'bun run db:check']) {
      const step = steps.find((candidate) => candidate.run === command);
      expect(step?.if).toBe("matrix.area != 'web'");
    }
    for (const variable of ['DATABASE_URL', 'REDIS_URL']) {
      expect(areas?.env?.[variable]).toContain("matrix.area != 'web' && '");
    }
    expect(AREAS.filter((area) => !needsServices(area))).toEqual(['web']);
  });

  test('every area keeps its coverage whether it passed or not, under the name the check looks for', () => {
    const keep = (areas?.steps ?? []).find((step) =>
      step.uses?.startsWith('actions/upload-artifact@'),
    );
    expect(keep?.if).toBe('${{ !cancelled() }}');
    expect(keep?.with?.['if-no-files-found']).toBe('error');
    expect(keep?.with?.['name']).toBe('area-${{ matrix.area }}');
    expect(keep?.with?.['path']).toBe('coverage/area-${{ matrix.area }}');
  });

  test('schema needs the areas and runs whatever became of them, so that a missing area is a failure it names', () => {
    expect(schema?.needs).toEqual(['scope', 'schema-area']);
    expect(schema?.if).toBe(`always() && ${notSkipped}`);
    const floor = schema?.steps?.find((step) => step.run === 'bun run coverage:floor');
    expect(floor?.if).toBeUndefined();
    expect(floor?.env?.['PURLAY_SCHEMA_AREA_RESULT']).toBe('${{ needs.schema-area.result }}');
  });

  test('schema downloads every area as the directory the check reads, and runs the check', () => {
    const steps = schema?.steps ?? [];
    const download = steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    expect(download?.if).toBe("needs.schema-area.result == 'success'");
    expect(download?.with?.['pattern']).toBe('area-*');
    expect(download?.with?.['path']).toBe('coverage');
    expect(download?.with?.['merge-multiple']).toBeUndefined();
    expect(steps.some((step) => step.run === 'bun run coverage:floor')).toBe(true);
  });

  test('the areas and the whole carry no way to fail and still succeed', () => {
    for (const name of ['schema-area', 'schema']) {
      const block =
        new RegExp(`^ {2}${name}:\\n([\\s\\S]*?)(?=^ {2}[\\w-]+:\\n|(?![\\s\\S]))`, 'm').exec(
          workflow,
        )?.[1] ?? '';
      expect(block).not.toBe('');
      expect(block).not.toContain('continue-on-error');
    }
  });
});
