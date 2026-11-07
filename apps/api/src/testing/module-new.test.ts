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
});

describe('against the repository as it is', () => {
  const names = namesOf('zz');

  test('every edit finds its anchor exactly once', () => {
    for (const edit of editsFor(names, OPTIONS)) {
      expect(() => applyEdit(readFileSync(join(ROOT, edit.file), 'utf8'), edit)).not.toThrow();
    }
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
    expect(edited('apps/api/src/composition.ts')).toContain('  zzModule,\n');
    expect(edited('packages/db/src/migrator.ts')).toContain("id: 'zz'");
    expect(edited('docs/DECISIONS.md')).toContain(`### D-${String(OPTIONS.decision)}.`);
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
