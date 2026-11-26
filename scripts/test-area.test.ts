import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  AREAS,
  areaDirectory,
  areaOfTest,
  needsServices,
  ownerOf,
  parseArea,
  readFloor,
  testFilesOnDisk,
  withoutFloor,
} from './test-area';

describe('which area a run is', () => {
  test('no variable, or an empty one, is the whole suite as before', () => {
    expect(parseArea(undefined)).toBeUndefined();
    expect(parseArea('')).toBeUndefined();
  });

  test.each(AREAS)('%s is an area', (area) => {
    expect(parseArea(area)).toBe(area);
  });

  test.each(['Web', 'api ', 'packages', 'all', '1/4', 'web,api'])(
    'refuses "%s": a run that ran everything or nothing would report a pass for the wrong suite',
    (value) => {
      expect(() => parseArea(value)).toThrow('PURLAY_TEST_AREA must be one of web, scripts, api');
    },
  );

  test('an area writes where the check looks, under the git-ignored coverage directory', () => {
    expect(areaDirectory('api')).toBe('coverage/area-api');
    expect(readFileSync('.gitignore', 'utf8')).toMatch(/^coverage\/$/m);
  });

  test('only the web area runs with no service', () => {
    expect(AREAS.filter((area) => !needsServices(area))).toEqual(['web']);
  });
});

describe('who owns a path', () => {
  test.each([
    ['apps/web/src/a.test.tsx', 'web'],
    ['apps/web/scripts/pdf-assets.test.ts', 'web'],
    ['apps/api/src/a.integration.test.ts', 'api'],
    ['packages/markdown/src/engine.ts', 'api'],
    ['packages/db/src/client.ts', 'api'],
    ['scripts/ci-gate.test.ts', 'scripts'],
  ] as const)('%s belongs to %s', (path, area) => {
    expect(ownerOf(path)).toBe(area);
  });

  test.each([
    'eslint.config.mjs',
    '../../../../tmp/purlay-mutations-at-x/scripts/mutations/a.ts',
    'apps/other/a.ts',
    'docs/a.test.ts',
  ])('%s belongs to no area, and is judged where it is loaded', (path) => {
    expect(ownerOf(path)).toBeUndefined();
  });
});

/**
 * The suite is divided by area, and the division must leave nothing out and run nothing twice: a test file that
 * belonged to no area would be run by no job, and CI would pass without it.
 */
describe('the areas are the whole suite', () => {
  const files = testFilesOnDisk();
  const of = (area: string): string[] => files.filter((file) => areaOfTest(file) === area);

  test('every test file on disk belongs to an area', () => {
    expect(files.filter((file) => areaOfTest(file) === undefined)).toEqual([]);
  });

  test('no test file belongs to two areas, and the areas together are every file', () => {
    const lists = AREAS.map(of);
    const union = lists.flat();
    expect(new Set(union).size).toBe(union.length);
    expect([...union].sort()).toEqual(files);
  });

  test('every area has tests to run', () => {
    for (const area of AREAS) expect(of(area).length).toBeGreaterThan(0);
  });

  test('a test file of an area is run in that area and not in another, wherever it sits', () => {
    expect(of('web')).toContain('apps/web/scripts/pdf-assets.test.ts');
    expect(of('scripts')).not.toContain('apps/web/scripts/pdf-assets.test.ts');
    expect(of('api')).toContain('packages/markdown/src/engine.test.ts');
    expect(of('scripts')).toContain('scripts/test-area.test.ts');
  });

  // The count that matters is Bun's: it finds the files by its own rules, and the areas must name the same ones.
  test('Bun finds exactly as many test files as the areas name', () => {
    const done = Bun.spawnSync(
      [
        'bun',
        '--no-env-file',
        'test',
        ...files,
        '--test-name-pattern',
        'NO TEST IS NAMED LIKE THIS',
      ],
      {
        env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
        timeout: 80_000,
      },
    );
    const output = `${done.stdout.toString()}${done.stderr.toString()}`;
    expect(/across (\d+) files/.exec(output)?.[1]).toBe(String(files.length));
  }, 90_000);
});

describe('the coverage floor, which bunfig.toml holds and nothing else does', () => {
  const bunfig = [
    '[test]',
    'preload = ["./a.ts"]',
    '# a comment that mentions coverageThreshold = { lines = 0.1, functions = 0.1 } in prose',
    'coverageThreshold = { lines = 0.96, functions = 0.95 }',
    'coveragePathIgnorePatterns = ["apps/*/src/testing/**"]',
    '',
  ].join('\n');

  test('is read from the line that sets it', () => {
    expect(readFloor(bunfig)).toEqual({ lines: 0.96, functions: 0.95 });
  });

  test('is the one the repository really holds', () => {
    const floor = readFloor(readFileSync('bunfig.toml', 'utf8'));
    expect(floor.lines).toBeGreaterThan(0.9);
    expect(floor.functions).toBeGreaterThan(0.9);
  });

  test('a configuration without the line is refused, never read as "no floor"', () => {
    expect(() => readFloor('[test]\npreload = []\n')).toThrow('has no `coverageThreshold');
    expect(() => withoutFloor('[test]\npreload = []\n')).toThrow('has no `coverageThreshold');
  });

  test('an area runs under the same configuration with only the floor at zero', () => {
    const open = withoutFloor(bunfig);
    expect(readFloor(open)).toEqual({ lines: 0, functions: 0 });
    const lines = (text: string): string[] => text.split('\n');
    const differing = lines(bunfig).filter((line, at) => line !== lines(open)[at]);
    expect(differing).toEqual(['coverageThreshold = { lines = 0.96, functions = 0.95 }']);
  });

  test('the real configuration keeps its preload and its ignored paths, and its line count', () => {
    const real = readFileSync('bunfig.toml', 'utf8');
    const open = withoutFloor(real);
    expect(open).toContain('preload = ["./packages/db/src/testing-preload.ts"');
    expect(open).toContain('coveragePathIgnorePatterns = ["apps/*/src/testing/**"]');
    expect(open.split('\n').length).toBe(real.split('\n').length);
  });
});
