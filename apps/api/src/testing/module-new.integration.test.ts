/**
 * The paved road, walked (`docs/MODULE-GUIDE.md`): the repository is copied to a directory of its own, `module:new zz --optional
 * issues` and then `module:new yy --optional zz` are run on the copy, a module's own declarations are written as its author
 * writes them (a fact, a kind of notice and a search source of `zz`, `yy` consuming the fact), and the checks that need no further
 * edit are run on what it made: the compilers, the guards of the module seams, the tests that list facts, kinds and sources, the
 * schema, and the documents. The one thing that must fail is the placeholder guard, naming exactly the lines the author owes; a
 * repeated run changes nothing.
 *
 * The copy gets a database of its own: its new migration set would otherwise be applied to the template every other
 * suite clones, and the schema would grow a table nobody owns.
 *
 * Slow on purpose (the compilers run on a whole repository): it is the only test that proves the generator and the
 * guards still agree, so a guard that starts to want a hand edit fails here and not in the first pull request of a new module.
 *
 * @needs-modules chat, issues
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

/** Replaces `from` by `to` in a file of the copy, which must hold it: the author's own edit, which the test makes by name. */
const authorEdit = (file: string, from: string, to: string): void => {
  const path = join(COPY, file);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`${file} does not hold ${from}`);
  writeFileSync(path, text.replace(from, to));
};

/**
 * What an author of two modules writes that the generator cannot: `zz` declares a fact, a kind of notice and a search source,
 * and `yy` consumes the fact. Every one of them used to break a test that lists none (`MODULES.md` §9).
 */
const writeDeclarations = (): void => {
  authorEdit(
    'packages/types/src/zz.ts',
    "import type { FactDeclaration } from './fact-declaration';",
    "import { defineFact, type FactDeclaration } from './fact-declaration';",
  );
  authorEdit(
    'packages/types/src/zz.ts',
    'export const ZZ_FACTS: readonly FactDeclaration[] = [];',
    `export const ZZ_FACTS: readonly FactDeclaration[] = [
  defineFact({ type: 'zz.made', owner: 'zz', absent: 'drop', schema: Type.Object({ id: Uuid }) }),
];

export const ZZ_NOTIFICATION_KINDS = [
  { type: 'zz_noticed', needsYou: true, pushed: true, mailed: false },
] as const;`,
  );
  authorEdit(
    'apps/api/src/features/zz/module.ts',
    "import { zzBudget } from './budget';",
    `import { ZZ_NOTIFICATION_KINDS } from '@purlay/types';
import type { NoticeWords } from '../../modules/push/notices';
import type { SearchSource } from '../../platform/ports/search-source';
import { zzBudget } from './budget';`,
  );
  authorEdit(
    'apps/api/src/features/zz/module.ts',
    'export const zzModule = {',
    `const zzNoticeWords: NoticeWords = (kind, locale, actor) =>
  kind === 'zz_noticed' ? { body: \`\${actor} \${locale}\`, path: 'zz' } : undefined;

const zzSearchSource: SearchSource = { id: 'zz', search: () => Promise.resolve([]) };

export const zzModule = {`,
  );
  authorEdit(
    'apps/api/src/features/zz/module.ts',
    '    jobs: [],\n  },',
    `    jobs: [],
    publishes: ['zz.made'],
    notifications: ZZ_NOTIFICATION_KINDS,
    searchSources: ['zz'],
  },
  noticeWords: zzNoticeWords,
  searchSources: [zzSearchSource],`,
  );
  authorEdit(
    'apps/api/src/features/yy/module.ts',
    "import { yyBudget } from './budget';",
    `import type { FactConsumer } from '../../platform/fact-consumers';
import { yyBudget } from './budget';`,
  );
  authorEdit(
    'apps/api/src/features/yy/module.ts',
    'export const yyModule = {',
    `const yyFactConsumers: Readonly<Record<string, FactConsumer>> = {
  'zz.made': () => Promise.resolve('done'),
};

export const yyModule = {`,
  );
  authorEdit(
    'apps/api/src/features/yy/module.ts',
    '    jobs: [],\n  },',
    "    jobs: [],\n    consumes: ['zz.made'],\n  },\n  factConsumers: yyFactConsumers,",
  );
};

const CHEAP_GUARDS = [
  'apps/api/src/composition.test.ts',
  'apps/api/src/fact-owners.test.ts',
  'apps/api/src/module-communication.test.ts',
  'apps/api/src/notification-kinds.test.ts',
  'packages/types/src/facts.test.ts',
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

/** The suites that read the module lists or the lists of facts, kinds and sources, and used to need an edit for a module's first. */
const LISTING_SUITES = [
  'apps/api/src/ingress/http/entitlement.integration.test.ts',
  'apps/api/src/ingress/http/find.integration.test.ts',
] as const;

const generate = (id: string, ...flags: string[]): Ran =>
  run(['bun', '--no-env-file', 'apps/api/src/testing/module-new.ts', id, ...flags]);

describe('integration: the paved road of a new module', () => {
  test(
    'makes two modules that the compilers and the guards accept with no hand edit, but for what they leave for their author',
    () => {
      copyRepository();

      const made = generate('zz', '--optional', 'issues');
      expect(made.output).toContain('edit  packages/db/src/schema.ts (generated)');
      expect(made.code).toBe(0);
      run(['git', 'add', '-A']);
      const second = generate('yy', '--optional', 'zz');
      expect(second.output).toContain('edit  docs/CONFIG.md');
      expect(second.code).toBe(0);
      writeDeclarations();
      run(['bunx', 'prettier', '--write', 'packages/types/src/zz.ts', 'apps/api/src/features']);
      run(['git', 'add', '-A']);

      // The new tables are in the committed types: migrating a clone and generating again changes nothing.
      const schema = run(['./scripts/check-schema.sh']);
      expect(schema.output).toContain('database types match the migrations');
      expect(schema.code).toBe(0);

      const types = run(['bunx', 'tsc', '--build', '--pretty', 'false']);
      expect(types.output).not.toContain('error TS');
      expect(types.code).toBe(0);

      const lint = run([
        'bunx',
        'eslint',
        'apps/api/src/features/zz',
        'apps/api/src/features/yy',
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

      const listings = run([
        'bun',
        '--no-env-file',
        'test',
        '--isolate',
        '--timeout=120000',
        ...LISTING_SUITES,
      ]);
      expect(listings.output).toContain(' 0 fail');
      expect(listings.code).toBe(0);

      const documents = run(['python3', 'scripts/check-docs.py']);
      expect(documents.output).toContain('[ok] no findings.');
      expect(documents.code).toBe(0);

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
        ...Array<string>(10).fill('docs/DECISIONS.md'),
        ...Array<string>(2).fill('docs/MODULES.md'),
      ]);
    },
    SLOW_MS,
  );

  test('a second run of either says the module exists and changes nothing', () => {
    run(['git', 'add', '-A']);
    const before = run(['git', 'status', '--porcelain']).output;
    for (const [id, partner] of [
      ['zz', 'issues'],
      ['yy', 'zz'],
    ] as const) {
      const again = generate(id, '--optional', partner);
      expect(again.output.trim()).toBe(`${id} exists already: nothing to do`);
      expect(again.code).toBe(0);
    }
    expect(run(['git', 'status', '--porcelain']).output).toBe(before);
  });

  test('a file whose line was moved stops the run and writes nothing', () => {
    const composition = join(COPY, 'apps/api/src/composition.ts');
    const original = Bun.file(composition);
    return original.text().then(async (text) => {
      await Bun.write(composition, text.replace('  issuesModule,\n', '  issuesModule, // moved\n'));
      const refused = generate('xx');
      expect(refused.code).toBe(1);
      expect(refused.output).toContain('apps/api/src/composition.ts: the anchor');
      expect(existsSync(join(COPY, 'apps/api/src/features/xx'))).toBe(false);
    });
  });
});
