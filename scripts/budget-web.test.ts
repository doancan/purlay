/**
 * The budget, proven to fail: a fat chunk is named, a grammar or a second locale in the
 * initial chunks is named, and a build inside the budget passes — against builds the test
 * writes itself, so it never depends on what Vite happened to emit today.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUDGET_BYTES,
  describeReport,
  initialAssets,
  main,
  measure,
  overBudget,
  shapeProblems,
} from './budget-web';

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
    expect(describeReport(report)).toContain('of 250.00 KB');
  });
});

describe('over the budget', () => {
  test('fails and names the chunk that is too big, with what to look at', () => {
    const dist = aBuild({
      'assets/index-aaa.js': incompressible(BUDGET_BYTES + 40_000),
      'theme-init.js': 'x',
    });
    const message = overBudget(measure(dist));
    expect(message).toContain('over the 250.00 KB budget');
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

describe('the command', () => {
  test('passes quietly inside the budget, with the report on stdout', () => {
    const dist = aBuild({ 'assets/index-aaa.js': incompressible(10_000), 'theme-init.js': 'x' });
    const result = main(dist);
    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('initial JavaScript, gzipped');
  });

  test('fails with the reason, the shape problem and the table when something is wrong', () => {
    const dist = aBuild({
      'assets/index-aaa.js': Buffer.concat([
        incompressible(BUDGET_BYTES + 5_000),
        Buffer.from('"scopeName"'),
      ]),
      'theme-init.js': 'x',
    });
    const result = main(dist);
    expect(result.code).toBe(1);
    expect(result.err).toContain('over the 250.00 KB budget');
    expect(result.err).toContain('syntax-highlighting');
    expect(result.out).toContain('assets/index-aaa.js');
  });
});
