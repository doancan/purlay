import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CORE_IMPORTS_OF_MODULES, webFences, webModuleIds } from './web-fences.mjs';
import {
  fenceProblems,
  isTestSource,
  moduleOfFile,
  staticClosure,
  webImports,
  type WebImport,
} from './web-imports';

const SRC = join(import.meta.dirname, '..', 'apps', 'web', 'src');
const FEATURES = join(SRC, 'features');

/** The core's imports of a module's files that remain, and the number the list may not grow past: lower it with the entry. */
const CORE_IMPORTS_CAP = 20;

const aTree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'web-src-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

const anImport = (from: string, to: string, over: Partial<WebImport> = {}): WebImport => ({
  from,
  to,
  lazy: false,
  typeOnly: false,
  ...over,
});

describe('what the compiler says a file imports', () => {
  test('a path in a comment or a string is not an import; a lazy one and a type are marked', () => {
    const src = aTree({
      'a.ts': [
        "// import x from './not-this';",
        'const text = "from \'./nor-this\'";',
        "import { b } from './b';",
        "import type { T } from './types';",
        "import { type U, type V } from './more-types';",
        "import { type W, w } from './mixed';",
        "export { c } from './c';",
        "export const d = () => import('./d');",
      ].join('\n'),
      'b.ts': 'export const b = 1;',
      'types.ts': 'export type T = 1;',
      'more-types.ts': 'export type U = 1; export type V = 2;',
      'mixed.ts': 'export type W = 1; export const w = 1;',
      'c.ts': 'export const c = 1;',
      'd.ts': 'export const d = 1;',
    });
    const found = webImports(src).filter(({ from }) => from === 'a.ts');
    expect(found.map(({ to, lazy, typeOnly }) => [to, lazy, typeOnly])).toEqual([
      ['b.ts', false, false],
      ['types.ts', false, true],
      ['more-types.ts', false, true],
      ['mixed.ts', false, false],
      ['c.ts', false, false],
      ['d.ts', true, false],
    ]);
  });

  test('a chunk is what its entry imports statically, and what that does: not a lazy import, not a type', () => {
    const imports = [
      anImport('entry.ts', 'a.ts'),
      anImport('a.ts', 'b.ts'),
      anImport('entry.ts', 'lazy.ts', { lazy: true }),
      anImport('entry.ts', 'types.ts', { typeOnly: true }),
      anImport('lazy.ts', 'deeper.ts'),
    ];
    expect([...staticClosure(imports, ['entry.ts'])].sort()).toEqual(['a.ts', 'b.ts', 'entry.ts']);
  });
});

describe('the web modules', () => {
  test('are the folders with a manifest, and a folder is named by the id its manifest declares', () => {
    const ids = webModuleIds(FEATURES);
    expect(ids).toEqual(['chat', 'issues']);
    for (const id of ids) {
      const manifest = readFileSync(join(FEATURES, id, 'manifest.ts'), 'utf8');
      expect(/^\s*id: '([\w-]+)',$/m.exec(manifest)?.[1]).toBe(id);
    }
  });

  test('are none where there is no folder', () => {
    expect(webModuleIds(join(tmpdir(), 'no-such-features-folder'))).toEqual([]);
  });

  test('a file is in the module whose folder it is in', () => {
    expect(moduleOfFile('features/chat/channel/x.ts', ['chat', 'issues'])).toBe('chat');
    expect(moduleOfFile('features/shell/x.ts', ['chat', 'issues'])).toBeUndefined();
    expect(moduleOfFile('ui/chat/x.ts', ['chat', 'issues'])).toBeUndefined();
  });
});

describe('the web client, as it is', () => {
  const ids = webModuleIds(FEATURES);
  const imports = webImports(SRC);

  test('no module imports another, and the core imports a module only where the list says', () => {
    expect(fenceProblems(imports, ids, CORE_IMPORTS_OF_MODULES)).toEqual([]);
  });

  test('the list of what the core still imports is capped, and gives a reason for each', () => {
    expect(CORE_IMPORTS_OF_MODULES.length).toBe(CORE_IMPORTS_CAP);
  });

  test('what the core still imports of chat is never a screen the chunk exists to keep out of the shell', () => {
    const screens = imports
      .filter(({ from, lazy, typeOnly }) => from === 'features/chat/chat.ts' && !lazy && !typeOnly)
      .map(({ to }) => to);
    expect(screens.length).toBeGreaterThan(0);
    const resident = staticClosure(
      imports,
      CORE_IMPORTS_OF_MODULES.filter(({ from }) => !isTestSource(from)).map(({ to }) => to),
    );
    expect(screens.filter((screen) => resident.has(screen))).toEqual([]);
  });
});

describe('the judge', () => {
  const ids = ['chat', 'issues'];
  const listed = [
    { from: 'features/shell/rail.tsx', to: 'features/chat/inbox/link.tsx', reason: 'r' },
  ];

  test('passes the registry’s manifests, a listed import, a test and a module’s own', () => {
    expect(
      fenceProblems(
        [
          anImport('modules/registry.ts', 'features/chat/manifest.ts'),
          anImport('modules/registry.ts', 'features/issues/manifest.ts'),
          anImport('features/shell/rail.tsx', 'features/chat/inbox/link.tsx'),
          anImport('features/shell/rail.test.tsx', 'features/chat/inbox/link.tsx'),
          anImport('testing/harness.tsx', 'features/chat/channel/screen.tsx'),
          anImport('features/chat/a.ts', 'features/chat/b.ts'),
        ],
        ids,
        listed,
      ),
    ).toEqual([]);
  });

  test('names a module that imports another, in its tests as well', () => {
    const problems = fenceProblems(
      [
        anImport('features/issues/a.ts', 'features/chat/b.ts', { typeOnly: true }),
        anImport('features/chat/a.test.ts', 'features/issues/issues-screen.tsx'),
      ],
      ids,
      [],
    );
    expect(problems).toEqual([
      'the issues module imports the chat module: features/issues/a.ts -> features/chat/b.ts',
      'the chat module imports the issues module: features/chat/a.test.ts -> features/issues/issues-screen.tsx',
    ]);
  });

  test('names a core file that imports a module and is not listed, and the registry reaching past a manifest', () => {
    const problems = fenceProblems(
      [
        anImport('features/shell/nav.tsx', 'features/chat/channel/x.ts', { lazy: true }),
        anImport('modules/registry.ts', 'features/chat/chat.ts'),
      ],
      ids,
      [],
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('features/shell/nav.tsx imports features/chat/channel/x.ts');
    expect(problems[1]).toContain('modules/registry.ts imports features/chat/chat.ts');
  });

  test('names an entry that is not an import any more, one listed twice and one with no reason', () => {
    const problems = fenceProblems([], ids, [
      ...listed,
      listed[0] ?? { from: '', to: '', reason: '' },
      { from: 'a.ts', to: 'features/chat/b.ts', reason: ' ' },
    ]);
    expect(problems.some((problem) => problem.includes('is listed twice'))).toBe(true);
    expect(problems.some((problem) => problem.includes('with no reason'))).toBe(true);
    expect(problems.filter((problem) => problem.includes('no longer an import'))).toHaveLength(2);
  });
});

describe('the lint blocks', () => {
  const patterns = [{ regex: '^climb', message: 'm' }];
  const blocks = webFences('src', ['chat', 'issues'], patterns, [
    'features/shell/a.tsx',
    'features/shell/a.tsx',
  ]);
  const blockFor = (file: string): (typeof blocks)[number] => {
    const found = blocks.find((block) => block.files[0] === file);
    if (found === undefined) throw new Error(`no block for ${file}`);
    return found;
  };
  const regexOf = (block: (typeof blocks)[number], at: number): RegExp =>
    new RegExp(block.rules['no-restricted-imports'][1].patterns[at]?.regex ?? '(?!)', 'u');

  test('one block for each module, one for the core and one for the registry, each keeping the web’s own patterns', () => {
    expect(blocks.map((block) => block.files[0])).toEqual([
      'src/features/chat/**/*.ts',
      'src/features/issues/**/*.ts',
      'src/**/*.ts',
      'src/modules/registry.ts',
    ]);
    for (const block of blocks) {
      expect(block.rules['no-restricted-imports'][1].patterns[0]).toEqual(patterns[0]);
    }
  });

  test('a module is kept from the other, by a path inside it and by a folder above', () => {
    const regex = regexOf(blockFor('src/features/chat/**/*.ts'), 1);
    expect(regex.test('../../issues/issues-screen')).toBe(true);
    expect(regex.test('../../../features/issues/x')).toBe(true);
    expect(regex.test('../channel/x')).toBe(false);
    expect(regex.test('../../data/issues-store')).toBe(false);
  });

  test('the core is kept from every module, except in a test, the harness, the registry and a listed file', () => {
    const core = blockFor('src/**/*.ts');
    const regex = regexOf(core, 1);
    for (const path of ['../features/chat/chat', '../chat/x', '../../features/issues/y']) {
      expect(regex.test(path)).toBe(true);
    }
    for (const path of ['../features/shell/x', '../../data/chat-thing', '../ui/chat']) {
      expect(regex.test(path)).toBe(false);
    }
    expect(core.ignores).toEqual([
      'src/features/chat/**/*.ts',
      'src/features/chat/**/*.tsx',
      'src/features/issues/**/*.ts',
      'src/features/issues/**/*.tsx',
      'src/modules/registry.ts',
      '**/*.test.ts',
      '**/*.test.tsx',
      'src/testing/**',
      'src/features/shell/a.tsx',
    ]);
  });

  test('the registry may import a manifest and nothing else of a module', () => {
    const regex = regexOf(blockFor('src/modules/registry.ts'), 1);
    expect(regex.test('../features/chat/manifest')).toBe(false);
    expect(regex.test('../features/issues/manifest')).toBe(false);
    expect(regex.test('../features/chat/chat')).toBe(true);
    expect(regex.test('../features/chat/manifest/x')).toBe(true);
    expect(regex.test('../features/chatty/x')).toBe(false);
  });
});
