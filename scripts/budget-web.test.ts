/**
 * The budget, proven to fail: a fat chunk is named, a grammar or a second locale in the
 * initial chunks is named, and a build inside the budget passes — against builds the test
 * writes itself, so it never depends on what Vite happened to emit today.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUDGET_BYTES,
  HEAVY_SOURCES,
  MODULE_BYTES,
  SHELL_BYTES,
  describeReport,
  initialAssets,
  main,
  measure,
  moduleIds,
  moduleProblems,
  overBudget,
  screenSources,
  shapeProblems,
  webModules,
} from './budget-web';

const FEATURES_DIRECTORY = join(import.meta.dirname, '..', 'apps', 'web', 'src', 'features');

const made: string[] = [];
afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** A build with these files; `index.html` loads the entry and preloads `preload`. */
const aBuild = (files: Record<string, string | Buffer>, preload: string[] = []): string => {
  const dist = mkdtempSync(join(tmpdir(), 'budget-'));
  made.push(dist);
  mkdirSync(join(dist, 'assets'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dist, name), content);
  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-aaa.js"></script>
${preload.map((href) => `<link rel="modulepreload" crossorigin href="/${href}">`).join('\n')}
<link rel="stylesheet" href="/assets/index-aaa.css">
<script src="/theme-init.js"></script>
<script src="https://cdn.example/analytics.js"></script>
</head><body><div id="root"></div></body></html>`,
  );
  return dist;
};

/** Bytes that do not compress, so a "fat chunk" really is fat once gzipped. */
const incompressible = (bytes: number): Buffer =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes)));

/** The files of a build whose shell has a source map listing `sources`, and whose chunks of chat and issues are these. */
const aShell = (
  sources: string[],
  chat: Buffer | string | null = 'x',
  issues: Buffer | string | null = 'x',
): Record<string, string | Buffer> => ({
  'assets/index-aaa.js': 'x',
  'assets/index-aaa.js.map': JSON.stringify({ sources, sourcesContent: sources.map(() => 'x') }),
  'theme-init.js': 'x',
  ...(chat === null ? {} : { 'assets/chat-ccc.js': chat }),
  ...(issues === null ? {} : { 'assets/issues-screen-ddd.js': issues }),
});

describe('which files are initial', () => {
  test('the entry script and the preloads, local only, and not the stylesheet or an outside script', () => {
    const html = readableHtml();
    expect(initialAssets(html)).toEqual([
      'assets/index-aaa.js',
      'theme-init.js',
      'assets/vendor-bbb.js',
    ]);
  });

  test('a preload written with href first is found too', () => {
    expect(initialAssets('<link href="/assets/x.js" rel="modulepreload">')).toEqual([
      'assets/x.js',
    ]);
  });
});

const readableHtml = (): string => `<script type="module" src="/assets/index-aaa.js"></script>
<link rel="modulepreload" href="/assets/vendor-bbb.js">
<link rel="stylesheet" href="/assets/index-aaa.css">
<script src="/theme-init.js"></script>
<script src="https://cdn.example/analytics.js"></script>
<link rel="modulepreload" href="//cdn.example/x.js">`;

describe('the measurement', () => {
  test('is gzipped, summed across the initial chunks, and listed largest first', () => {
    const dist = aBuild(
      {
        'assets/index-aaa.js': 'a'.repeat(50_000),
        'assets/vendor-bbb.js': incompressible(20_000),
        'theme-init.js': 'x',
        'assets/lazy-ccc.js': incompressible(900_000),
      },
      ['assets/vendor-bbb.js'],
    );
    const report = measure(dist);
    expect(report.chunks.map((c) => c.file)).toEqual([
      'assets/vendor-bbb.js',
      'assets/index-aaa.js',
      'theme-init.js',
    ]);
    expect(report.chunks[0]?.gzip).toBeGreaterThan(15_000);
    // The repetitive entry compresses hard; a lazy chunk is not in the total at all.
    expect(report.chunks[1]?.gzip).toBeLessThan(500);
    expect(report.totalGzip).toBe(report.chunks.reduce((sum, c) => sum + c.gzip, 0));
    expect(report.totalRaw).toBe(50_000 + 20_000 + 1);
  });

  test('inside the budget passes, and the report says how much of it is spent', () => {
    const dist = aBuild({ 'assets/index-aaa.js': incompressible(10_000), 'theme-init.js': 'x' });
    const report = measure(dist);
    expect(overBudget(report)).toBeNull();
    expect(shapeProblems(dist, report)).toEqual([]);
    expect(describeReport(report)).toContain('of 400.00 KB');
  });
});

describe('over the budget', () => {
  test('fails and names the chunk that is too big, with what to look at', () => {
    const dist = aBuild({
      'assets/index-aaa.js': incompressible(BUDGET_BYTES + 40_000),
      'theme-init.js': 'x',
    });
    const message = overBudget(measure(dist));
    expect(message).toContain('over the 400.00 KB budget');
    expect(message).toContain('The largest chunk is assets/index-aaa.js');
    expect(message).toContain('PURLAY_SOURCEMAP=1');
  });

  test('with a source map, names the sources inside the largest chunk', () => {
    const dist = aBuild({
      'assets/index-aaa.js': incompressible(BUDGET_BYTES + 10_000),
      'theme-init.js': 'x',
      'assets/index-aaa.js.map': JSON.stringify({
        sources: ['src/small.ts', 'node_modules/huge-library/index.js'],
        sourcesContent: ['a', 'b'.repeat(5_000)],
      }),
    });
    const text = describeReport(measure(dist));
    expect(text).toContain('largest sources in assets/index-aaa.js');
    expect(text.indexOf('huge-library')).toBeLessThan(text.indexOf('small.ts'));
  });

  test('a map with no sources, or no content, does not break the report', () => {
    const dist = aBuild({
      'assets/index-aaa.js': 'x',
      'theme-init.js': 'x',
      'assets/index-aaa.js.map': '{}',
    });
    expect(describeReport(measure(dist))).not.toContain('largest sources');
    const partial = aBuild({
      'assets/index-aaa.js': 'x',
      'theme-init.js': 'x',
      'assets/index-aaa.js.map': JSON.stringify({ sources: ['a.ts'] }),
    });
    expect(describeReport(measure(partial))).toContain('a.ts');
  });
});

describe('the shape the budget protects', () => {
  test('a highlighter grammar in an initial chunk is named', () => {
    const dist = aBuild({
      'assets/index-aaa.js': 'const g = {"scopeName":"source.ts"};',
      'theme-init.js': 'x',
    });
    const problems = shapeProblems(dist, measure(dist));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('assets/index-aaa.js contains syntax-highlighting code');
  });

  test('a module’s screen in an initial chunk is named, for every module that has a manifest, and the word it is found by is the screen’s own', () => {
    for (const id of moduleIds()) {
      const dist = aBuild({
        'assets/index-aaa.js': `h("div",{"data-screen":"screen-of-the-${id}-module"})`,
        'theme-init.js': 'x',
      });
      const problems = shapeProblems(dist, measure(dist));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`assets/index-aaa.js contains the ${id} module's screen`);
    }
    const clean = aBuild({ 'assets/index-aaa.js': 'const shell = 1;', 'theme-init.js': 'x' });
    expect(shapeProblems(clean, measure(clean))).toEqual([]);
    // The word lives in the screen's file, not in a manifest the shell carries. Chat is found by its sources instead.
    for (const module of webModules().filter(({ id }) => id !== 'chat')) {
      const [screen] = screenSources(module);
      expect(readFileSync(join(FEATURES_DIRECTORY, '..', screen ?? ''), 'utf8')).toContain(
        `'screen-of-the-${module.id}-module'`,
      );
    }
  });

  test('the modules are the ids their manifests declare, found by the folder they sit in', () => {
    const declared = readdirSync(FEATURES_DIRECTORY).filter((folder) =>
      existsSync(join(FEATURES_DIRECTORY, folder, 'manifest.ts')),
    );
    expect(moduleIds()).toHaveLength(declared.length);
    expect(moduleIds().length).toBeGreaterThanOrEqual(2);
    // A module added later needs its chunk's bound chosen, and a bound for no module is a module that went.
    expect(Object.keys(MODULE_BYTES).sort()).toEqual(moduleIds().sort());
    const folders = mkdtempSync(join(tmpdir(), 'features-'));
    made.push(folders);
    for (const [name, text] of [
      ['a/manifest.ts', "export const a = defineModule({\n  id: 'alpha-beta',\n  load: x,\n});"],
      ['b/other.ts', 'x'],
      ['c/manifest.ts', 'export const c = {};'],
    ] as const) {
      mkdirSync(join(folders, name.split('/')[0] ?? ''), { recursive: true });
      writeFileSync(join(folders, name), text);
    }
    expect(() => moduleIds(folders)).toThrow('declares no');
    rmSync(join(folders, 'c'), { recursive: true });
    expect(moduleIds(folders)).toEqual(['alpha-beta']);
  });

  test('two locale catalogues in the initial chunks is named; one is allowed', () => {
    const both = aBuild(
      {
        'assets/index-aaa.js': 'x',
        'assets/en-AAA.js': 'x',
        'assets/tr-BBB.js': 'x',
        'theme-init.js': 'x',
      },
      ['assets/en-AAA.js', 'assets/tr-BBB.js'],
    );
    expect(shapeProblems(both, measure(both))[0]).toContain('2 locale catalogues');
    const one = aBuild(
      { 'assets/index-aaa.js': 'x', 'assets/en-AAA.js': 'x', 'theme-init.js': 'x' },
      ['assets/en-AAA.js'],
    );
    expect(shapeProblems(one, measure(one))).toEqual([]);
  });
});

describe('the files the first page is cut into', () => {
  test('initial modules in more than one file are named; a locale catalogue beside the entry is not', () => {
    const cut = aBuild(
      { 'assets/index-aaa.js': 'x', 'assets/toast-bbb.js': 'x', 'theme-init.js': 'x' },
      ['assets/toast-bbb.js'],
    );
    const problems = shapeProblems(cut, measure(cut));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cut into 2 files (assets/index-aaa.js, assets/toast-bbb.js)');
    const whole = aBuild({ 'assets/index-aaa.js': 'x', 'theme-init.js': 'x' });
    expect(shapeProblems(whole, measure(whole))).toEqual([]);
  });

  test('a push worker that imports a chunk is named; one that imports nothing is not', () => {
    for (const imports of ['import"./assets/index-aaa.js";', 'self.x = import("./a.js");']) {
      const dist = aBuild({
        'assets/index-aaa.js': 'x',
        'theme-init.js': 'x',
        'push-worker.js': imports,
      });
      const problems = shapeProblems(dist, measure(dist));
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('push-worker.js imports another file');
    }
    const alone = aBuild({
      'assets/index-aaa.js': 'x',
      'theme-init.js': 'x',
      'push-worker.js': 'var important = 1; self.addEventListener("push", () => important);',
    });
    expect(shapeProblems(alone, measure(alone))).toEqual([]);
  });
});

describe("where each module's code is", () => {
  const problemsOf = (files: Record<string, string | Buffer>, features?: string): string[] => {
    const dist = aBuild(files);
    return moduleProblems(dist, measure(dist), features);
  };

  test("a shell with the other features and a chunk of each module's own passes", () => {
    expect(
      problemsOf(
        aShell([
          '../../src/features/sidebar/sidebar.tsx',
          '../../src/features/channel/feed-ports.tsx',
        ]),
      ),
    ).toEqual([]);
  });

  test("the screens are read from the manifests' entries, and the heavy files are real files", () => {
    const sources = Object.fromEntries(
      webModules().map((module) => [module.id, screenSources(module)]),
    );
    expect(sources['chat']).toContain('features/chat/chat.ts');
    expect(sources['chat']).toContain('features/channel/channel-screen.tsx');
    expect(sources['chat']).toContain('features/unreads/unreads-screen.tsx');
    expect(sources['issues']).toEqual(['features/issues/issues-screen.tsx']);
    // A type-only import of the manifest is no screen, and a shared helper is not named.
    expect(sources['chat']?.some((file) => file.endsWith('manifest.ts'))).toBe(false);
    for (const file of Object.values(HEAVY_SOURCES).flat()) {
      expect(existsSync(join(FEATURES_DIRECTORY, '..', file))).toBe(true);
    }
  });

  test('a chat screen or the composer in the shell is named, and the shared files are not', () => {
    const [problem, ...rest] = problemsOf(
      aShell([
        '../../src/features/channel/channel-screen.tsx',
        '../../src/features/composer/composer.tsx',
        '../../src/features/channel/feed-ports.tsx',
      ]),
    );
    expect(rest).toEqual([]);
    expect(problem).toContain("assets/index-aaa.js contains the chat module's screens");
    expect(problem).toContain(
      'features/channel/channel-screen.tsx, features/composer/composer.tsx',
    );
    expect(problem).not.toContain('feed-ports');
  });

  test("issues' screen in the shell is named", () => {
    const [problem, ...rest] = problemsOf(aShell(['../../src/features/issues/issues-screen.tsx']));
    expect(rest).toEqual([]);
    expect(problem).toContain("assets/index-aaa.js contains the issues module's screens");
  });

  test('a shell with no source map is a failure that says how to build one, not a pass', () => {
    const [problem] = problemsOf({
      'assets/index-aaa.js': 'x',
      'theme-init.js': 'x',
      'assets/chat-ccc.js': 'x',
      'assets/issues-screen-ddd.js': 'x',
    });
    expect(problem).toContain('no source map');
    expect(problem).toContain('bun run build:web:mapped');
  });

  test('a build with no chunk of a module’s own is named, for each module', () => {
    const [chat] = problemsOf(aShell([], null));
    expect(chat).toContain(
      "the chat module's screens have no chunk of their own (assets/chat-*.js)",
    );
    const [issues] = problemsOf(aShell([], 'x', null));
    expect(issues).toContain('no chunk of their own (assets/issues-screen-*.js)');
  });

  test('a shell over its bound, and a chunk over its module’s, are named', () => {
    const shell = problemsOf({
      ...aShell([]),
      'assets/index-aaa.js': incompressible(SHELL_BYTES + 5_000),
    });
    expect(shell).toHaveLength(1);
    expect(shell[0]).toContain('the shell is');
    const chat = problemsOf(aShell([], incompressible((MODULE_BYTES['chat'] ?? 0) + 5_000)));
    expect(chat).toHaveLength(1);
    expect(chat[0]).toContain("over the chat module's 50.00 KB bound");
    const issues = problemsOf(
      aShell([], 'x', incompressible((MODULE_BYTES['issues'] ?? 0) + 2_000)),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("over the issues module's 3.00 KB bound");
  });

  test('a module with no bound, and a manifest that loads no entry, are named', () => {
    const features = mkdtempSync(join(tmpdir(), 'features-'));
    made.push(features);
    for (const [name, text] of [
      [
        'notes/manifest.ts',
        "defineModule({\n  id: 'notes',\n  load: () => import('./notes-screen'),\n});",
      ],
      ['notes/notes-screen.tsx', 'export const x = 1;'],
      ['odd/manifest.ts', "defineModule({\n  id: 'odd',\n  load: load,\n});"],
    ] as const) {
      mkdirSync(join(features, name.split('/')[0] ?? ''), { recursive: true });
      writeFileSync(join(features, name), text);
    }
    const problems = problemsOf({ ...aShell([]), 'assets/notes-screen-eee.js': 'x' }, features);
    expect(problems.some((problem) => problem.includes('the notes module has no bound'))).toBe(
      true,
    );
    expect(
      problems.some((problem) => problem.includes("the odd module's manifest does not load")),
    ).toBe(true);
  });

  test('a heavy file that is gone is named, so a move cannot leave the check holding nothing', () => {
    const features = mkdtempSync(join(tmpdir(), 'features-'));
    made.push(features);
    const problems = problemsOf(aShell([]), features);
    expect(
      problems.some((problem) => problem.includes('is named in HEAVY_SOURCES and is not a file')),
    ).toBe(true);
  });

  test('the shell bound sits under the backstop', () => {
    expect(SHELL_BYTES).toBeLessThan(BUDGET_BYTES);
  });
});

describe('the command', () => {
  test('passes quietly inside the budget, with the report on stdout', () => {
    const dist = aBuild(aShell([]));
    const result = main(dist);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('initial JavaScript, gzipped');
  });

  test('fails with the reason, the shape problem and the table when something is wrong', () => {
    const dist = aBuild({
      ...aShell([]),
      'assets/index-aaa.js': Buffer.concat([
        incompressible(BUDGET_BYTES + 5_000),
        Buffer.from('"scopeName"'),
      ]),
    });
    const result = main(dist);
    expect(result.code).toBe(1);
    expect(result.err).toContain('over the 400.00 KB budget');
    expect(result.err).toContain('syntax-highlighting');
    expect(result.out).toContain('assets/index-aaa.js');
  });

  test('fails when a chat screen is back in the shell, and says where it loads from', () => {
    const dist = aBuild(aShell(['../../src/features/unreads/unreads-screen.tsx']));
    const result = main(dist);
    expect(result.code).toBe(1);
    expect(result.err).toContain('features/unreads/unreads-screen.tsx');
    expect(result.err).toContain('features/chat/chat.ts');
  });
});
