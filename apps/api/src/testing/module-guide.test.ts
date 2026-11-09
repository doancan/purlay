/**
 * `docs/MODULE-GUIDE.md` names files and commands; each exists (`CONTRIBUTING.md` §6.1: a second copy is bound by a test).
 * Paths are checked where they start at the repository's root; a path with a placeholder for the module's id is an example.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '../../../..');
const guide = readFileSync(join(ROOT, 'docs/MODULE-GUIDE.md'), 'utf8');
const quoted = [...guide.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? '');
/** The module id the guide's commands and tables use: the first `module:new <id>` it shows. */
const EXAMPLE_ID = /bun run module:new ([a-z][a-z0-9-]*)/.exec(guide)?.[1] ?? '';

describe('the module guide', () => {
  test('names only paths that exist', () => {
    const paths = quoted.filter(
      (token) =>
        /^(apps|packages|scripts|docs|\.github)\//.test(token) &&
        !/[<>*]|zz/.test(token) &&
        !token.includes(EXAMPLE_ID) &&
        !token.includes(' '),
    );
    expect(paths.length).toBeGreaterThan(5);
    expect(paths.filter((path) => !existsSync(join(ROOT, path)))).toEqual([]);
  });

  test('names only short paths that exist under a source root (`platform/ports/fact-publisher.ts`)', () => {
    const ROOTS = [
      'apps/api/src',
      'apps/web/src',
      'packages/db',
      'packages/db/src',
      'packages/types/src',
    ];
    const short = quoted.filter(
      (token) =>
        /^[a-z][\w.-]*(\/[\w.-]+)+\.(ts|tsx|sql|json|md|yml)$/.test(token) &&
        !/^(apps|packages|scripts|docs|\.github)\//.test(token) &&
        !token.includes('zz') &&
        !token.includes(EXAMPLE_ID),
    );
    expect(short.length).toBeGreaterThan(1);
    expect(
      short.filter((path) => !ROOTS.some((root) => existsSync(join(ROOT, root, path)))),
    ).toEqual([]);
  });

  test('names only commands the root package has', () => {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const commands = [...guide.matchAll(/bun run ([a-z:-]+)/g)].map((match) => match[1] ?? '');
    expect(commands).toContain('module:new');
    expect(commands.filter((command) => !(command in scripts))).toEqual([]);
  });

  test('uses an example id that no test of the repository uses as a fixture', () => {
    expect(EXAMPLE_ID).not.toBe('');
    const tests = Bun.spawnSync(['git', 'ls-files', '*.test.ts', '*.test.tsx'], { cwd: ROOT })
      .stdout.toString()
      .trim()
      .split('\n');
    // A module id as a test names one (`id: 'x'`, `optional: ['x']`, `xModule`), not any string that spells it.
    const quotedId = new RegExp(
      `\\b(?:id|producer|module|requires|optional)\\s*[:=]\\s*\\[?\\s*['"]${EXAMPLE_ID}['"]|\\b${EXAMPLE_ID}Module\\b`,
    );
    const users = tests.filter(
      (file) =>
        file !== 'apps/api/src/testing/module-guide.test.ts' &&
        quotedId.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(users).toEqual([]);
  });

  test('tells the author of a grant what the build refuses, and does not say it is closed already', () => {
    expect(guide).toContain("entitlement: 'always'");
    expect(guide).toContain('unguardedWorkProblem');
    expect(guide).not.toMatch(/marks as built or not|already closed when it is off/);
  });

  test('points at the glossary that says what its words mean', () => {
    expect(guide).toContain('`MODULES.md` §12');
    expect(readFileSync(join(ROOT, 'docs/MODULES.md'), 'utf8')).toMatch(
      /^## 12\. Glossary[^]*\*\*module, feature, package\.\*\*/m,
    );
  });

  test('is the length of a guide, and is listed among the documents', () => {
    expect(guide.split('\n').length).toBeLessThanOrEqual(250);
    expect(readFileSync(join(ROOT, 'docs/OVERVIEW.md'), 'utf8')).toContain('MODULE-GUIDE.md');
  });
});
