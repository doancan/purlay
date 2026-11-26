/**
 * `test:all` in CI with a test service missing: a refusal, not half a suite reported as the whole one.
 * The case with a database and no Redis needs a database, and is `test-all.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs the script itself with only the environment given; it must refuse before starting a test. */
const testAll = (environment: Record<string, string>): { exitCode: number; output: string } => {
  // From an empty directory: a run that fails to refuse finds no tests there, and ends at once,
  // rather than running this suite — and this test — again underneath itself.
  const done = Bun.spawnSync(['bun', '--no-env-file', join(import.meta.dir, 'test-all.ts')], {
    cwd: mkdtempSync(join(tmpdir(), 'test-all-')),
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...environment },
    timeout: 20_000,
  });
  return { exitCode: done.exitCode, output: `${done.stdout.toString()}${done.stderr.toString()}` };
};

describe('test:all in CI', () => {
  test('refuses when DATABASE_URL is not set', () => {
    const { exitCode, output } = testAll({ CI: 'true' });
    expect(exitCode).toBe(1);
    expect(output).toContain('DATABASE_URL is not set, and CI provides the database. Refusing');
  });

  test('refuses an unknown cohort mode before delegating the clock', () => {
    const { exitCode, output } = testAll({ CI: 'true', PURLAY_WORKSPACE_COHORT: 'typo' });
    expect(exitCode).toBe(1);
    expect(output).toContain('PURLAY_WORKSPACE_COHORT must be functional or measure');
  });

  test('refuses when nothing answers at the database', () => {
    const { exitCode, output } = testAll({
      CI: 'true',
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
    });
    expect(exitCode).toBe(1);
    expect(output).toContain(
      'nothing answers at 127.0.0.1:1, and CI provides the database. Refusing',
    );
  });
});

describe('test:all as one area of the suite (D-341)', () => {
  test.each(['Web', 'packages', 'api ', 'all', '1/4'])(
    'refuses PURLAY_TEST_AREA=%s before starting a test',
    (area) => {
      const { exitCode, output } = testAll({ CI: 'true', PURLAY_TEST_AREA: area });
      expect(exitCode).toBe(1);
      expect(output).toContain('PURLAY_TEST_AREA must be one of web, scripts, api');
    },
  );

  test.each(['api', 'scripts'])(
    'refuses the %s area when there is no database, rather than running the unit tests under its name',
    (area) => {
      for (const environment of [{}, { CI: 'true' }]) {
        const { exitCode, output } = testAll({ ...environment, PURLAY_TEST_AREA: area });
        expect(exitCode).toBe(1);
        expect(output).toContain(
          `PURLAY_TEST_AREA=${area} needs the database, and DATABASE_URL is not set`,
        );
        expect(output).not.toContain('INTEGRATION TESTS NOT RUN');
      }
    },
  );

  test('refuses an area that needs the database when nothing answers there, in CI or out of it', () => {
    const { exitCode, output } = testAll({
      PURLAY_TEST_AREA: 'api',
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
    });
    expect(exitCode).toBe(1);
    expect(output).toContain('needs the database, and nothing answers at 127.0.0.1:1');
  });

  test('the web area runs with no service at all, under a configuration without the floor, and says what it ran', () => {
    const directory = mkdtempSync(join(tmpdir(), 'test-all-web-'));
    writeFileSync(
      join(directory, 'bunfig.toml'),
      '[test]\ncoverageThreshold = { lines = 0.96, functions = 0.95 }\n',
    );
    mkdirSync(join(directory, 'apps/web'), { recursive: true });
    // Half of this file never runs: under the real floor Bun would fail it, and the area must not.
    writeFileSync(
      join(directory, 'apps/web/half.ts'),
      'export const used = (): number => 1;\nexport const unused = (): number => {\n  return 2;\n};\n',
    );
    writeFileSync(
      join(directory, 'apps/web/half.test.ts'),
      "import { expect, test } from 'bun:test';\nimport { used } from './half';\ntest('uses it', () => {\n  expect(used()).toBe(1);\n});\n",
    );
    const done = Bun.spawnSync(['bun', '--no-env-file', join(import.meta.dir, 'test-all.ts')], {
      cwd: directory,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? '',
        CI: 'true',
        PURLAY_TEST_AREA: 'web',
      },
      timeout: 60_000,
    });
    expect(`${done.stdout.toString()}${done.stderr.toString()}`).toContain(
      'the web area, with coverage to judge, with no service',
    );
    expect(done.exitCode).toBe(0);
    const summary = JSON.parse(
      readFileSync(join(directory, 'coverage/area-web/summary.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({ area: 'web', files: 1, expected: 1, exitCode: 0 });
    const lcov = readFileSync(join(directory, 'coverage/area-web/lcov.info'), 'utf8');
    expect(lcov).toContain('SF:apps/web/half.ts');
    expect(readFileSync(join(directory, 'coverage/area-web/bunfig.toml'), 'utf8')).toContain(
      'lines = 0.0, functions = 0.0',
    );
  }, 70_000);

  test('without the variable, the suite runs as it always did: one run of every root, with coverage', () => {
    expect(readFileSync('scripts/test-all.ts', 'utf8')).toContain(
      "process.exit(run([...ROOTS, '--coverage', ...redisLeftOut]));",
    );
  });

  test('an area is told its own test files, a configuration without the floor and where to write lcov', () => {
    const source = readFileSync('scripts/test-all.ts', 'utf8');
    for (const argument of [
      '...files,',
      '`--config=${config}`',
      "'--coverage-reporter=lcov'",
      '`--coverage-dir=${directory}`',
      'areaOfTest(file) === area',
    ]) {
      expect(source).toContain(argument);
    }
  });
});

test('the general suite delegates only the cohort clock to the required standalone measurement', () => {
  expect(readFileSync('scripts/test-all.ts', 'utf8')).toContain(
    "env: { ...process.env, PURLAY_WORKSPACE_COHORT: 'functional' }",
  );
});
