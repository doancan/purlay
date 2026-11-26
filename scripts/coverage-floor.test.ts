import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Measured,
  type Summary,
  checkAreas,
  judgeArea,
  main,
  parseLcov,
  shortfallOf,
  unjudged,
} from './coverage-floor';
import type { Area } from './test-area';

/** One file's record as Bun writes it: line hits, then the function counts. */
const record = (path: string, hits: readonly number[], fnf: number, fnh: number): string =>
  [
    `SF:${path}`,
    `FNF:${String(fnf)}`,
    `FNH:${String(fnh)}`,
    ...hits.map((count, at) => `DA:${String(at + 1)},${String(count)}`),
    `LF:${String(hits.length)}`,
    `LH:${String(hits.filter((count) => count > 0).length)}`,
    'end_of_record',
    '',
  ].join('\n');

const FLOOR = { lines: 0.96, functions: 0.95 };
const measured = (linesHit: number, linesFound: number, fnh: number, fnf: number): Measured => ({
  linesHit,
  linesFound,
  functionsHit: fnh,
  functionsFound: fnf,
});

describe('reading what Bun writes', () => {
  test('a record has its lines counted, hit and not, and its function counts', () => {
    const files = parseLcov(`TN:\n${record('a.ts', [3, 0, 1], 4, 3)}${record('b.ts', [1], 0, 0)}`);
    expect([...files.keys()]).toEqual(['a.ts', 'b.ts']);
    expect(files.get('a.ts')).toEqual(measured(2, 3, 3, 4));
  });

  test('a record that never ended is not a file', () => {
    expect(parseLcov('SF:a.ts\nDA:1,1\nFNF:1\nFNH:1\n').size).toBe(0);
  });
});

describe('the floor, per file, as Bun holds it', () => {
  test('a file at the floor passes, and one a hair under it fails', () => {
    // 24 of 25 lines is exactly 96 %; 23 of 25 is 92 %.
    expect(shortfallOf('a.ts', measured(24, 25, 19, 20), FLOOR)).toEqual([]);
    const [under] = shortfallOf('a.ts', measured(23, 25, 19, 20), FLOOR);
    expect(under?.detail).toBe('92.00% of lines (23/25), floor 96.00%');
  });

  test('functions have a floor of their own: 19 of 20 passes, 18 of 20 fails', () => {
    expect(shortfallOf('a.ts', measured(10, 10, 19, 20), FLOOR)).toEqual([]);
    const [under] = shortfallOf('a.ts', measured(10, 10, 18, 20), FLOOR);
    expect(under?.detail).toBe('90.00% of functions (18/20), floor 95.00%');
  });

  test('a file under both floors is named for both, and one with nothing to cover is covered', () => {
    expect(shortfallOf('a.ts', measured(1, 10, 1, 10), FLOOR)).toHaveLength(2);
    expect(shortfallOf('types.ts', measured(0, 0, 0, 0), FLOOR)).toEqual([]);
  });
});

describe('what an area answers for', () => {
  const files = new Map<string, Measured>([
    ['apps/web/src/a.ts', measured(10, 10, 5, 5)],
    ['apps/web/src/weak.ts', measured(5, 10, 5, 5)],
    ['packages/markdown/src/m.ts', measured(1, 10, 1, 10)],
    ['eslint.config.mjs', measured(10, 10, 3, 3)],
    ['../../../../tmp/purlay-mutations-at-x/scripts/mutations/a.ts', measured(9, 10, 3, 3)],
  ]);

  test('the web area is judged on its own files and on the ones nobody owns, and leaves another area’s to it', () => {
    const { judged, elsewhere } = judgeArea('web', files, FLOOR);
    expect(judged.judged).toBe(4);
    expect(elsewhere).toEqual(['packages/markdown/src/m.ts']);
    expect(judged.shortfalls.map((shortfall) => shortfall.path).sort()).toEqual([
      '../../../../tmp/purlay-mutations-at-x/scripts/mutations/a.ts',
      'apps/web/src/weak.ts',
    ]);
  });

  test('the same files are the api area’s to answer for only when they are its own', () => {
    const { judged, elsewhere } = judgeArea('api', files, FLOOR);
    expect(elsewhere.sort()).toEqual(['apps/web/src/a.ts', 'apps/web/src/weak.ts']);
    expect(judged.shortfalls.map((shortfall) => shortfall.path)).toContain(
      'packages/markdown/src/m.ts',
    );
  });

  test('says which file is the lowest, so that a run shows how near the floor it is', () => {
    const { judged } = judgeArea('web', files, FLOOR);
    expect(judged.lowestLines?.path).toBe('apps/web/src/weak.ts');
    expect(judged.lowestLines?.share).toBe(0.5);
    expect(judged.lowestFunctions?.share).toBe(1);
  });
});

describe('a file cannot escape the floor by being loaded only by another area', () => {
  test('is named when an area loaded it and its owner did not', () => {
    const loaded = new Map<Area, ReadonlySet<string>>([
      ['web', new Set(['apps/web/a.ts', 'packages/markdown/src/m.ts'])],
      ['api', new Set(['apps/api/src/x.ts'])],
    ]);
    const elsewhere = new Map<Area, readonly string[]>([['web', ['packages/markdown/src/m.ts']]]);
    expect(unjudged(loaded, elsewhere)).toEqual([
      'packages/markdown/src/m.ts: loaded by the web tests and not by the api tests that own it, so it is judged nowhere',
    ]);
  });

  test('is not named when its owner loaded it too', () => {
    const loaded = new Map<Area, ReadonlySet<string>>([
      ['web', new Set(['packages/markdown/src/m.ts'])],
      ['api', new Set(['packages/markdown/src/m.ts'])],
    ]);
    expect(unjudged(loaded, new Map([['web', ['packages/markdown/src/m.ts']]]))).toEqual([]);
  });
});

describe('the areas are the whole suite', () => {
  const tests = [
    'apps/web/a.test.ts',
    'apps/web/b.test.ts',
    'apps/api/c.test.ts',
    'packages/d.test.ts',
    'scripts/e.test.ts',
  ];
  const summary = (area: string, files: number, exitCode = 0): Summary => ({
    area,
    tests: 9,
    files,
    exitCode,
  });
  const all = (web = 2, scripts = 1, api = 2): Map<Area, Summary> =>
    new Map<Area, Summary>([
      ['web', summary('web', web)],
      ['scripts', summary('scripts', scripts)],
      ['api', summary('api', api)],
    ]);

  test('three areas that each ran exactly the files they own are whole', () => {
    expect(checkAreas(all(), tests)).toEqual([]);
  });

  test('an area that dropped a file, or ran one twice, is named with both numbers', () => {
    expect(checkAreas(all(1), tests)).toEqual([
      'the web area ran 1 test files and owns 2: a file was dropped or run twice',
    ]);
    expect(checkAreas(all(2, 1, 3), tests)).toEqual([
      'the api area ran 3 test files and owns 2: a file was dropped or run twice',
    ]);
  });

  test('an area that failed is named, whatever its coverage', () => {
    const failed = all();
    failed.set('api', summary('api', 2, 1));
    expect(checkAreas(failed, tests)).toEqual(['the api area ended with exit code 1']);
  });

  test('a test file that belongs to no area is named, because no job would run it', () => {
    expect(checkAreas(all(), [...tests, 'docs/f.test.ts'])).toEqual([
      '1 test files belong to no area, so no job runs them: docs/f.test.ts',
    ]);
  });
});

/** The command, on a tree that is a pretend checkout: the areas it was handed, the files on disk, the floor. */
describe('the command, which is what CI runs', () => {
  interface Handed {
    lcov: string;
    summary: Summary | undefined;
  }
  const checkout = (areas: Partial<Record<Area, Handed>>): string => {
    const root = mkdtempSync(join(tmpdir(), 'floor-'));
    writeFileSync(
      join(root, 'bunfig.toml'),
      '[test]\ncoverageThreshold = { lines = 0.96, functions = 0.95 }\n',
    );
    for (const file of [
      'apps/web/a.test.ts',
      'apps/api/b.test.ts',
      'packages/c.test.ts',
      'scripts/d.test.ts',
    ]) {
      mkdirSync(join(root, file, '..'), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    for (const [area, handed] of Object.entries(areas)) {
      mkdirSync(join(root, 'coverage', `area-${area}`), { recursive: true });
      writeFileSync(join(root, 'coverage', `area-${area}`, 'lcov.info'), handed.lcov);
      if (handed.summary !== undefined) {
        writeFileSync(
          join(root, 'coverage', `area-${area}`, 'summary.json'),
          JSON.stringify(handed.summary),
        );
      }
    }
    return root;
  };
  const summary = (area: string, files: number, exitCode = 0): Summary => ({
    area,
    tests: 5,
    files,
    exitCode,
  });
  const good = (area: Area, files: number, lcov: string): Handed => ({
    lcov,
    summary: summary(area, files),
  });
  const covered = (path: string): string => record(path, [1, 1, 1, 1], 2, 2);
  const run = (root: string): number => {
    const { log, error } = console;
    console.log = (): void => undefined;
    console.error = (): void => undefined;
    try {
      return main(join(root, 'coverage'), root);
    } finally {
      console.log = log;
      console.error = error;
    }
  };
  const whole = (): Partial<Record<Area, Handed>> => ({
    web: good('web', 1, covered('apps/web/src/a.ts')),
    scripts: good('scripts', 1, covered('scripts/d.ts')),
    api: good('api', 2, covered('apps/api/src/b.ts') + covered('packages/markdown/src/m.ts')),
  });

  test('passes three whole areas over the floor', () => {
    expect(run(checkout(whole()))).toBe(0);
  });

  test.each(['failure', 'cancelled', 'skipped', ''])(
    'CI refuses a matrix result of %j even with three complete reports',
    (result) => {
      const root = checkout(whole());
      const command = Bun.spawnSync(
        [process.execPath, 'run', join(import.meta.dir, 'coverage-floor.ts')],
        { cwd: root, env: { CI: 'true', PURLAY_SCHEMA_AREA_RESULT: result } },
      );
      expect(command.exitCode).toBe(1);
      expect(command.stderr.toString()).toContain('the suite is not whole');
    },
  );

  test('passes a file the web tests load and the api tests, which own it, cover', () => {
    const areas = whole();
    areas.web = good(
      'web',
      1,
      covered('apps/web/src/a.ts') + record('packages/markdown/src/m.ts', [1, 0, 0, 0], 4, 1),
    );
    expect(run(checkout(areas))).toBe(0);
  });

  test('fails a doctored report whose file is under the floor in its own area', () => {
    const areas = whole();
    areas.api = good(
      'api',
      2,
      covered('apps/api/src/b.ts') + record('packages/markdown/src/m.ts', [1, 0, 0, 0], 2, 2),
    );
    expect(run(checkout(areas))).toBe(1);
  });

  test('fails a file at the floor in lines and under it in functions', () => {
    const areas = whole();
    areas.web = good('web', 1, record('apps/web/src/a.ts', [1, 1, 1, 1], 20, 18));
    expect(run(checkout(areas))).toBe(1);
  });

  test('fails a file only another area’s tests loaded, which its own area never ran', () => {
    const areas = whole();
    areas.api = good('api', 2, covered('apps/api/src/b.ts'));
    areas.web = good(
      'web',
      1,
      covered('apps/web/src/a.ts') + covered('packages/markdown/src/m.ts'),
    );
    expect(run(checkout(areas))).toBe(1);
  });

  test('fails when an area dropped a file, even though everything it did run is covered', () => {
    const areas = whole();
    areas.api = good('api', 1, covered('apps/api/src/b.ts'));
    expect(run(checkout(areas))).toBe(1);
  });

  test('fails an area that never wrote its summary or its coverage, or was never run', () => {
    const noSummary = whole();
    noSummary.web = { lcov: covered('apps/web/src/a.ts'), summary: undefined };
    expect(run(checkout(noSummary))).toBe(1);
    const missing = whole();
    delete missing.scripts;
    expect(run(checkout(missing))).toBe(1);
    expect(run(checkout({}))).toBe(1);
  });

  test('fails an area that exited non-zero', () => {
    const areas = whole();
    areas.web = { lcov: covered('apps/web/src/a.ts'), summary: summary('web', 1, 1) };
    expect(run(checkout(areas))).toBe(1);
  });
});
