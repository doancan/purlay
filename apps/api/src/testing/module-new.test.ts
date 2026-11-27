/**
 * `bun run module:new` (`docs/MODULE-GUIDE.md`): the names it derives, the editor that refuses a missing anchor, and that every
 * edit and template still applies to the repository as it is. The run on a copy of the repository is `module-new.integration.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { PRODUCT_MODULE_IDS } from '@purlay/db';
import { RESERVED_MODULE_IDS } from '../platform/module-kit/registry';
import { main, parseArguments } from './module-new';
import { editsFor } from './module-new/edits';
import { applyEdit, fill, idProblem, namesOf, templateFiles } from './module-new/plan';

const ROOT = join(import.meta.dir, '../../../..');
const OPTIONS = { requires: [], optional: ['issues'], decision: 999 };

describe('the names of a module', () => {
  test('are one word in each case the code needs', () => {
    expect(namesOf('my-tasks')).toEqual({
      id: 'my-tasks',
      pascal: 'MyTasks',
      camel: 'myTasks',
      snake: 'my_tasks',
      upper: 'MY_TASKS',
      title: 'My tasks',
      lower: 'my tasks',
    });
  });

  test('refuse an id that is malformed, reserved or taken, and accept a new one', () => {
    const taken = new Set(PRODUCT_MODULE_IDS);
    for (const bad of ['Notes', '1notes', 'no_tes', 'a'.repeat(33), 'a--b', 'a-', '']) {
      expect(idProblem(bad, taken, RESERVED_MODULE_IDS)).toBeDefined();
    }
    expect(idProblem('workspaces', taken, RESERVED_MODULE_IDS)).toContain('core owns');
    expect(idProblem('chat', taken, RESERVED_MODULE_IDS)).toContain('already a module');
    expect(idProblem('my-tasks', taken, RESERVED_MODULE_IDS)).toBeUndefined();
  });

  test("refuse the words the build uses for no module and every module, the core's services and the names of its tables", () => {
    const taken = new Set(PRODUCT_MODULE_IDS);
    for (const id of [
      'core',
      'none',
      'all',
      'search',
      'find',
      'inbox',
      'users',
      'outbox',
      'audit-log',
      'sessions',
    ]) {
      expect(idProblem(id, taken, RESERVED_MODULE_IDS), id).toContain('core owns');
    }
  });
});

describe('the editor', () => {
  const edit = { file: 'a.ts', anchor: 'two\n', text: 'two\nthree\n' };

  test('replaces its anchor, and appends when it has none', () => {
    expect(applyEdit('one\ntwo\n', edit)).toBe('one\ntwo\nthree\n');
    expect(applyEdit('one\n', { file: 'a.md', text: 'end\n' })).toBe('one\nend\n');
  });

  test('refuses an anchor that is not there, or is there twice, naming the file', () => {
    expect(() => applyEdit('one\n', edit)).toThrow('a.ts: the anchor');
    expect(() => applyEdit('two\ntwo\n', edit)).toThrow('not there exactly once');
  });
});

describe('the arguments', () => {
  test('are an id and the flags it knows', () => {
    expect(parseArguments(['zz', '--optional', 'issues', '--dry-run'])).toEqual({
      id: 'zz',
      dryRun: true,
      options: { requires: [], optional: ['issues'] },
    });
    expect(parseArguments(['zz', '--wat'])).toBe('unknown flag --wat');
    expect(parseArguments([])).toContain('usage');
  });

  test('--help prints the usage and succeeds, wherever it stands', () => {
    for (const argv of [['--help'], ['zz', '--help'], ['-h']]) {
      const said: string[] = [];
      expect(main(argv, ROOT, (line) => said.push(line))).toBe(0);
      expect(said.join('\n')).toContain('usage: bun run module:new <id>');
    }
  });
});

describe('the command, asked for what it cannot make', () => {
  const run = (argv: string[]): { code: number; said: string[] } => {
    const said: string[] = [];
    return { code: main(argv, ROOT, (line) => said.push(line)), said };
  };

  test('refuses a reserved id with 2 and writes nothing', () => {
    for (const id of ['core', 'none', 'users', 'outbox', 'all']) {
      const { code, said } = run([id, '--dry-run']);
      expect({ id, code }).toEqual({ id, code: 2 });
      expect(said.join('\n')).toContain('core owns');
    }
  });

  test('prints its usage for --help and -h, and makes nothing', () => {
    for (const flag of ['--help', '-h']) {
      const { code, said } = run([flag]);
      expect(code).toBe(0);
      expect(said.join('\n')).toContain('usage: bun run module:new <id>');
    }
  });
});

describe('against the repository as it is', () => {
  const names = namesOf('zz');

  test('every edit finds its anchor exactly once', () => {
    for (const edit of editsFor(names, OPTIONS)) {
      expect(() => applyEdit(readFileSync(join(ROOT, edit.file), 'utf8'), edit)).not.toThrow();
    }
  });

  test('the web half is wired where a screen is found, drawn and forgotten', () => {
    const edits = editsFor(namesOf('zz'), OPTIONS);
    const after = (file: string): string =>
      edits
        .filter((edit) => edit.file === file)
        .reduce((text, edit) => applyEdit(text, edit), readFileSync(join(ROOT, file), 'utf8'));
    const registry = after('apps/web/src/modules/registry.ts');
    expect(registry).toContain("import { zz } from '../features/zz/manifest';");
    expect(registry).toMatch(/export const MODULES = \[[^\]]*\bzz\b[^\]]*\] as const;/);
    // A workspace's content is forgotten when the person's access to it changes: a module's rows are that content.
    expect(after('apps/web/src/data/access-change.ts')).toContain("keys.zz('')[0],");
    expect(after('apps/web/src/data/keys.ts')).toContain(
      "zz: (workspaceId: string) => ['zz', workspaceId] as const,",
    );
    expect(after('apps/web/src/data/api.ts')).toContain('...createZzApi(http),');
    expect(after('apps/web/src/router/route-modules.test.ts')).toContain("zz: 'zz',");
    // The Turkish words are English until the author says them, and the generator says so where it is read (`scaffold-leftovers.test.ts`).
    const owed = ['<<', 'FILL', '>>'].join('');
    expect(
      after('apps/web/src/i18n/catalogue/tr.ts')
        .split('\n')
        .filter((line) => line.includes(owed)),
    ).toHaveLength(3);
  });

  test('the registry’s list takes a module whether it is on one line or one to a line once it is too long', () => {
    const edit = editsFor(namesOf('zz'), OPTIONS).find(
      (found) => found.file === 'apps/web/src/modules/registry.ts' && found.anchor?.startsWith(']'),
    );
    if (edit === undefined) throw new Error('the registry list has no edit');
    const tail = '] as const;\n\nexport type ModuleManifestOf = 1;';
    expect(applyEdit(`export const MODULES = [chat, issues${tail}`, edit)).toContain(
      '[chat, issues, zz] as const',
    );
    expect(applyEdit(`export const MODULES = [\n  chat,\n  issues,\n${tail}`, edit)).toContain(
      '  issues,\n  zz,\n] as const',
    );
  });

  test('a second module finds every anchor the first one left, whatever the number of modules before it', () => {
    const made = new Map<string, string>();
    const contentOf = (file: string): string =>
      made.get(file) ?? readFileSync(join(ROOT, file), 'utf8');
    for (const id of ['zz', 'yy', 'xx']) {
      for (const edit of editsFor(namesOf(id), OPTIONS)) {
        expect(() => applyEdit(contentOf(edit.file), edit), `${id}: ${edit.file}`).not.toThrow();
        made.set(edit.file, applyEdit(contentOf(edit.file), edit));
      }
    }
    expect(made.get('docs/CONFIG.md')).toContain('`chat`, `issues`, `zz`, `yy`, `xx`. **Unset');
    expect(made.get('packages/types/src/facts.ts')).toContain(
      '...CORE_FACTS, ...XX_FACTS, ...YY_FACTS, ...ZZ_FACTS',
    );
  });

  test('every template is filled, in its path and its text, and none is a file that exists', () => {
    const files = templateFiles(names, OPTIONS);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      expect(`${file.path}\n${file.content}`).not.toMatch(/__[A-Z]+(_[A-Z]+)*__/);
      expect(() => readFileSync(join(ROOT, file.path))).toThrow();
    }
    expect(files.map((file) => file.path)).toContain(
      'apps/api/src/features/zz/degradation.testing.ts',
    );
    expect(
      templateFiles(names, { ...OPTIONS, optional: [] }).map((file) => file.path),
    ).not.toContain('apps/api/src/features/zz/degradation.testing.ts');
  });

  test('the edits give the module its row in the documents, its cases at the crossing and its line in the registries', () => {
    const edited = (file: string): string =>
      editsFor(names, OPTIONS)
        .filter((edit) => edit.file === file)
        .reduce(
          (content, edit) => applyEdit(content, edit),
          readFileSync(join(ROOT, file), 'utf8'),
        );
    expect(edited('docs/MODULES.md')).toContain('| `zz` | — | `issues` | — |');
    expect(edited('docs/MODULES.md')).toContain('### `zz`');
    expect(edited('docs/SCHEMA.md')).toContain('CREATE TABLE zz');
    expect(edited('docs/API.md')).toContain('`/api/workspaces/:workspaceId/zz`');
    expect(edited('apps/api/src/testing/cross-tenant.ts')).toContain(
      "'POST /api/workspaces/:workspaceId/zz'",
    );
    expect(edited('apps/api/src/composition.ts')).toContain('  issuesModule,\n  zzModule,\n');
    expect(edited('packages/db/src/migrator.ts')).toContain("id: 'zz'");
    const decision = templateFiles(names, OPTIONS).find((file) =>
      file.path.startsWith(`docs/decisions/architecture/D-${String(OPTIONS.decision)}-zz-`),
    );
    expect(decision?.content).toStartWith(`# D-${String(OPTIONS.decision)}. `);
  });

  test('the pool-share test is made for the module, and names it among the modules it needs', () => {
    const made = templateFiles(names, OPTIONS).find(
      (file) => file.path === 'apps/api/src/features/zz/http/budget.integration.test.ts',
    );
    expect(made?.content).toContain('@needs-modules chat, zz');
  });

  test('a manifest says what it does without each optional partner it lists', () => {
    expect(fill('__DEGRADES__', names, OPTIONS)).toContain("issues: 'Works without issues");
  });

  test('a dry run says what it would do and writes nothing', () => {
    const said: string[] = [];
    expect(main(['zz', '--dry-run'], ROOT, (line) => said.push(line))).toBe(0);
    expect(said).toContain('would make  apps/api/src/features/zz/module.ts');
    expect(said).toContain('would edit  apps/api/src/composition.ts');
    expect(() => readFileSync(join(ROOT, 'apps/api/src/features/zz/module.ts'))).toThrow();
  });

  test('a module that exists is left alone, and a bad id or partner is refused', () => {
    const said: string[] = [];
    expect(main(['issues'], ROOT, (line) => said.push(line))).toBe(0);
    expect(said).toEqual(['issues exists already: nothing to do']);
    expect(main(['Bad'], ROOT, () => undefined)).toBe(2);
    expect(main(['zz', '--optional', 'nope', '--dry-run'], ROOT, () => undefined)).toBe(2);
  });
});
