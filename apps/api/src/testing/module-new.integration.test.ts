/**
 * The paved road, walked (`docs/MODULE-GUIDE.md`): the repository is copied to a directory of its own, `module:new zz --optional
 * issues` is run on the copy, and the checks that need no further edit are run on what it made: the compilers, the guards of
 * the module seams, and the documents. The one thing that must fail is the placeholder guard, naming exactly the lines the
 * author owes; a second run changes nothing.
 *
 * The copy gets a database of its own: its new migration set would otherwise be applied to the template every other
 * suite clones, and the schema would grow a table nobody owns.
 *
 * Slow on purpose (the compilers run on a whole repository): it is the only test that proves the generator and the
 * guards still agree, so a guard that starts to want a hand edit fails here and not in the first pull request of a new module.
 *
 * @needs-modules chat, issues
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  dropDatabases,
  integrationTemplateName,
  type ClonedDatabase,
} from '@purlay/db';

const ROOT = join(import.meta.dir, '../../../..');
const COPY = mkdtempSync(join(tmpdir(), 'module-new-'));
const SLOW_MS = 900_000;

let own: ClonedDatabase;

beforeAll(async () => {
  own = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  rmSync(COPY, { recursive: true, force: true });
  const name = new URL(own.connectionString).pathname.slice(1);
  await own.drop();
  await dropDatabases([integrationTemplateName(name)]);
}, DROP_HOOK_MS);

interface Ran {
  readonly code: number;
  readonly output: string;
}

const run = (args: string[], env: Record<string, string> = {}): Ran => {
  const done = Bun.spawnSync(args, {
    cwd: COPY,
    env: { ...process.env, DATABASE_URL: own.connectionString, ...env },
    stderr: 'pipe',
  });
  return { code: done.exitCode, output: `${done.stdout.toString()}${done.stderr.toString()}` };
};

/** The files git would carry, copied; `node_modules` shared, and each package's own links copied as links so they resolve to the copy. */
const copyRepository = (): void => {
  const files = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd: ROOT })
    .stdout.toString()
    .split('\0')
    .filter((file) => file !== '' && existsSync(join(ROOT, file)));
  for (const file of files) {
    mkdirSync(dirname(join(COPY, file)), { recursive: true });
    cpSync(join(ROOT, file), join(COPY, file));
  }
  symlinkSync(join(ROOT, 'node_modules'), join(COPY, 'node_modules'));
  for (const group of ['apps', 'packages']) {
    for (const name of new Bun.Glob('*').scanSync({ cwd: join(ROOT, group), onlyFiles: false })) {
      const modules = join(ROOT, group, name, 'node_modules');
      if (existsSync(modules)) {
        cpSync(modules, join(COPY, group, name, 'node_modules'), {
          recursive: true,
          verbatimSymlinks: true,
        });
      }
    }
  }
  run(['git', 'init', '-q']);
  run(['git', 'add', '-A']);
  run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'copy']);
};

const CHEAP_GUARDS = [
  'apps/api/src/composition.test.ts',
  'apps/api/src/degradation.test.ts',
  'apps/api/src/module-budgets.test.ts',
  'apps/api/src/module-deadlines.test.ts',
  'apps/api/src/module-listing.test.ts',
  'apps/api/src/module-seams.test.ts',
  'apps/api/src/module-setting-pair.test.ts',
  'apps/api/src/module-tables.test.ts',
  'apps/api/src/core-claims.test.ts',
  'apps/api/src/export-catalogue.test.ts',
  'apps/api/src/testing/cross-tenant.test.ts',
  'apps/api/src/testing/module-smoke.test.ts',
  'apps/api/src/testing/module-suites.test.ts',
  'apps/api/src/cli/budget-latency.test.ts',
  'apps/api/src/contract/bundle.test.ts',
  'apps/api/src/ingress/http/route-ownership.test.ts',
  'packages/db/src/migration-safety.test.ts',
  'packages/db/src/migration-sets.test.ts',
  'packages/db/src/migrations.test.ts',
  'packages/db/src/data-map.test.ts',
  'scripts/mutations.test.ts',
] as const;

describe('integration: the paved road of a new module', () => {
  test(
    'makes a module that the compilers and the guards accept with no hand edit, but for what it leaves for its author',
    () => {
      copyRepository();
      const databaseUrl = own.connectionString;

      const made = run(
        [
          'bun',
          '--no-env-file',
          'apps/api/src/testing/module-new.ts',
          'zz',
          '--optional',
          'issues',
        ],
        { DATABASE_URL: databaseUrl },
      );
      expect(made.output).toContain('edit  packages/db/src/schema.ts (generated)');
      expect(made.code).toBe(0);
      run(['git', 'add', '-A']);

      const types = run(['bunx', 'tsc', '--build', '--pretty', 'false']);
      expect(types.output).not.toContain('error TS');
      expect(types.code).toBe(0);

      const lint = run([
        'bunx',
        'eslint',
        'apps/api/src/features/zz',
        'apps/api/src/testing',
        'packages/types/src',
      ]);
      expect(lint.output).toBe('');

      const guards = run([
        'bun',
        '--no-env-file',
        'test',
        '--isolate',
        '--timeout=120000',
        ...CHEAP_GUARDS,
      ]);
      expect(guards.output).toContain(' 0 fail');
      expect(guards.code).toBe(0);

      const leftovers = run([
        'bun',
        '--no-env-file',
        'test',
        'apps/api/src/testing/scaffold-leftovers.test.ts',
      ]);
      expect(leftovers.code).not.toBe(0);
      const owed = run(['git', 'grep', '-n', '-F', ['<<', 'FILL', '>>'].join(''), '--', 'docs'])
        .output.split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split(':')[0]);
      expect(owed).toEqual([
        'docs/DECISIONS.md',
        'docs/DECISIONS.md',
        'docs/DECISIONS.md',
        'docs/DECISIONS.md',
        'docs/DECISIONS.md',
        'docs/MODULES.md',
      ]);
    },
    SLOW_MS,
  );

  test('a second run says the module exists and changes nothing', () => {
    const before = run(['git', 'status', '--porcelain']).output;
    const again = run([
      'bun',
      '--no-env-file',
      'apps/api/src/testing/module-new.ts',
      'zz',
      '--optional',
      'issues',
    ]);
    expect(again.output.trim()).toBe('zz exists already: nothing to do');
    expect(again.code).toBe(0);
    expect(run(['git', 'status', '--porcelain']).output).toBe(before);
  });

  test('a file whose line was moved stops the run and writes nothing', () => {
    const composition = join(COPY, 'apps/api/src/composition.ts');
    const original = Bun.file(composition);
    return original.text().then(async (text) => {
      await Bun.write(
        composition,
        text.replace('] as const satisfies readonly BundledModule[];', ']'),
      );
      const refused = run(['bun', '--no-env-file', 'apps/api/src/testing/module-new.ts', 'yy']);
      expect(refused.code).toBe(1);
      expect(refused.output).toContain('apps/api/src/composition.ts: the anchor');
      expect(existsSync(join(COPY, 'apps/api/src/features/yy'))).toBe(false);
    });
  });
});
