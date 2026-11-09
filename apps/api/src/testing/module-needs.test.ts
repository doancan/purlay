import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { bundledModules } from '../composition';
import { declaredNeeds, needsReader, relativeImports } from './module-needs';

const IDS = bundledModules.map((module) => module.manifest.id);
const API_SOURCE = join(import.meta.dir, '..');

const scratch = mkdtempSync(join(tmpdir(), 'module-needs-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A file in a directory of its own, with the text given. */
const aFile = (name: string, text: string): string => {
  const path = join(scratch, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
};

/** The import of a real file of the API from a scratch file, written the way a test writes it. */
const importOf = (target: string): string =>
  `import '${relative(scratch, join(API_SOURCE, target)).replace(/\.ts$/, '')}';\n`;

describe('what a suite declares', () => {
  test('is the ids on a `@needs-modules` line, in a comment, however they are separated', () => {
    expect(
      declaredNeeds('/**\n * About a thing.\n *\n * @needs-modules chat, issues\n */\n'),
    ).toEqual(['chat', 'issues']);
    expect(declaredNeeds('// @needs-modules chat\nconst x = 1;\n')).toEqual(['chat']);
    expect(declaredNeeds('  * @needs-modules   issues  \n')).toEqual(['issues']);
  });

  test('is nothing where the words are in the middle of a line or of a statement', () => {
    expect(declaredNeeds("const note = '// @needs-modules chat';\n")).toEqual([]);
    expect(declaredNeeds('a suite that @needs-modules chat, said in prose\n')).toEqual([]);
    expect(declaredNeeds('')).toEqual([]);
  });
});

describe('what a suite imports', () => {
  test('is every relative path loaded: static, dynamic and re-exported, and not the types alone, nor a comment, nor a package', () => {
    const source = [
      "import { a } from './a';",
      "import type { T } from './only-a-type';",
      "export type { U } from './also-only-a-type';",
      "export { b } from '../b';",
      "const c = await import('./c');",
      "import '@purlay/db';",
      "// import { d } from './in-a-comment';",
      "import { type E, f } from './f';",
    ].join('\n');
    expect(relativeImports(source)).toEqual(['./a', '../b', './c', './f']);
  });
});

describe('which modules a suite needs', () => {
  const needs = needsReader(IDS);

  test('none, for a suite that imports nothing of a module and says nothing', () => {
    expect(needs(aFile('plain.test.ts', "import { expect } from 'bun:test';\n"))).toEqual([]);
  });

  test('a module, for a suite that imports its code, and through a helper as much as directly', () => {
    const helper = aFile('helper.ts', importOf('features/chat/channels/guard.ts'));
    expect(needs(aFile('direct.test.ts', importOf('features/chat/channels/guard.ts')))).toEqual([
      'chat',
    ]);
    expect(needs(aFile('indirect.test.ts', `import './${relative(scratch, helper)}';\n`))).toEqual([
      'chat',
    ]);
  });

  test('a module, for a suite whose file is in the module’s folder, with no import at all', () => {
    expect(needs(join(API_SOURCE, 'features', 'chat', 'jobs.integration.test.ts'))).toContain(
      'chat',
    );
  });

  test('what a helper declares reaches every suite that imports it, and a cycle among helpers ends', () => {
    aFile('fixture.ts', "// @needs-modules issues\nimport './fixture-back';\n");
    aFile('fixture-back.ts', "import './fixture';\n");
    expect(needs(aFile('uses-fixture.test.ts', "import './fixture';\n"))).toEqual(['issues']);
  });

  test('not a module, for a suite that imports the files that put the modules together or only a type of one', () => {
    const root = importOf('composition.ts');
    const typeOnly = `import type { X } from '${relative(scratch, join(API_SOURCE, 'features/chat/channels/guard'))}';\n`;
    expect(needs(aFile('composes.test.ts', root + typeOnly))).toEqual([]);
  });

  test('every module of the build, for a suite that names them all, in the order of the build', () => {
    const named = aFile('both.test.ts', `// @needs-modules ${[...IDS].reverse().join(', ')}\n`);
    expect(needs(named)).toEqual([...IDS].sort());
  });
});

describe('how often it reads a file', () => {
  test('once, however many suites reach it and however many times a suite is asked', () => {
    aFile('shared-helper.ts', '// @needs-modules chat\n');
    const first = aFile('first-reader.test.ts', "import './shared-helper';\n");
    const second = aFile('second-reader.test.ts', "import './shared-helper';\n");
    const reads = new Map<string, number>();
    const counting = (file: string): string => {
      reads.set(file, (reads.get(file) ?? 0) + 1);
      return readFileSync(file, 'utf8');
    };
    const needs = needsReader(IDS, counting);
    // Every cell of the module matrix asks about every suite again: the answers do not change, and
    // reading each file of each suite's whole import tree again each time took seconds.
    for (const file of [first, second, first, second]) expect(needs(file)).toEqual(['chat']);
    expect([...reads.values()]).toEqual([1, 1, 1]);
  });
});
