/**
 * The initial-JavaScript budget, measured from the build and blocking (D-49, #140).
 *
 *   bun run budget:web          measure apps/web/dist; exit 1 above the budget
 *
 * "Initial" is what the browser must download before the first screen can run: the
 * scripts `index.html` loads and the modules it preloads — nothing a route, a
 * dialog, a locale or a highlighter loads later. Measured gzipped, because that is
 * what crosses the wire and what `PRD.md` §5 budgets: 400 KB — a backstop against an accident, not a ceiling for
 * features (D-196).
 *
 * **A failure says what grew, not only that something did**: the chunks, largest first,
 * and — when the build kept a source map (`bun run build:web:mapped`) — the
 * sources inside the largest one. A budget that only reports a number gets raised; one
 * that names the dependency that arrived gets a decision.
 *
 * It also judges the *shape* the budget exists to protect: no syntax-highlighting grammar
 * in the initial chunks (they load on first use, D-36), at most one locale catalogue
 * (the other is loaded only if asked for, D-41), the initial modules in one file and the
 * push worker in one of its own (D-163). Each is cheap to break and invisible until the
 * number moves.
 *
 * **The shell holds no chat screen** (D-250, `docs/MODULES.md` §6): chat's screens are a chunk of their own,
 * `assets/chat-*.js`, which the shell asks for with `import()` and which is not initial. The check reads the
 * source maps of the initial chunks, so it needs `bun run build:web:mapped`, and fails — rather
 * than passing unproven — when there is none. Two bounds go with it, set from the measured build
 * (2026-11-03: shell 242.04 KB gzipped, chat 45.65 KB) with a margin for a feature or two: the shell's at
 * 250 KB, 3% above what was measured, so the 400 KB backstop above is no longer what catches a screen that
 * crept back; chat's at 50 KB, 10% above. They move up in a commit that says why, as the backstop does.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const BUDGET_BYTES = 400 * 1024;
/** The shell's own bound: the initial JavaScript with chat's screens in their own chunk. */
export const SHELL_BYTES = 250 * 1024;
/** Chat's chunk, gzipped: the screens, the composer, the feed and the threads. */
export const CHAT_BYTES = 50 * 1024;

/**
 * Chat's entry modules and the heavy ones under them. A source map of an initial chunk that lists any of these
 * means a static import has put chat back into the shell. What is not listed (the sidebar's links, the read
 * caches and the panels the frame hosts) is shared with the shell and stays in it.
 */
const CHAT_ONLY_SOURCES = [
  'features/channel/channel-screen.tsx',
  'features/inbox/inbox-screen.tsx',
  'features/questions/questions-screen.tsx',
  'features/search/search-screen.tsx',
  'features/saved/saved-screen.tsx',
  'features/drafts/drafts-screen.tsx',
  'features/unreads/unreads-screen.tsx',
  'features/composer/composer.tsx',
  'features/channel/message-feed.tsx',
  'features/messages/message-row.tsx',
  'features/threads/thread.tsx',
];
const CHAT_CHUNK = /^chat-[\w-]+\.js$/;

export interface Chunk {
  readonly file: string;
  readonly raw: number;
  readonly gzip: number;
}

export interface Report {
  readonly chunks: readonly Chunk[];
  readonly totalGzip: number;
  readonly totalRaw: number;
  /** Source files inside a chunk, largest first, when a source map was kept. */
  readonly sources: ReadonlyMap<
    string,
    readonly { readonly source: string; readonly bytes: number }[]
  >;
}

/** A script of this site's own: not a full URL and not a protocol-relative one. */
const isLocalScript = (reference: string): boolean =>
  !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference) && /^[^?#]+\.js$/.test(reference);

/** The scripts and preloads an `index.html` asks for first, as paths relative to the build. */
export const initialAssets = (indexHtml: string): string[] => {
  const found = new Set<string>();
  const patterns = [
    /<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g,
    /<link\b[^>]*\brel="modulepreload"[^>]*\bhref="([^"]+)"[^>]*>/g,
    /<link\b[^>]*\bhref="([^"]+)"[^>]*\brel="modulepreload"[^>]*>/g,
  ];
  for (const pattern of patterns) {
    for (const match of indexHtml.matchAll(pattern)) {
      const reference = match[1] ?? '';
      if (isLocalScript(reference)) found.add(reference.replace(/^\//, ''));
    }
  }
  return [...found];
};

/** Looks for the source map's sources, and how much source text each carries. */
const sourcesOf = (
  dist: string,
  file: string,
): { readonly source: string; readonly bytes: number }[] | null => {
  const path = join(dist, `${file}.map`);
  if (!existsSync(path)) return null;
  const map = JSON.parse(readFileSync(path, 'utf8')) as {
    sources?: string[];
    sourcesContent?: (string | null)[];
  };
  const sources = map.sources ?? [];
  return sources
    .map((source, index) => ({ source, bytes: map.sourcesContent?.[index]?.length ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes);
};

export const measure = (dist: string): Report => {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const chunks: Chunk[] = [];
  const sources = new Map<string, { source: string; bytes: number }[]>();
  for (const file of initialAssets(html)) {
    const bytes = readFileSync(join(dist, file));
    chunks.push({ file, raw: bytes.length, gzip: gzipSync(bytes).length });
    const inside = sourcesOf(dist, file);
    if (inside !== null) sources.set(file, inside);
  }
  chunks.sort((a, b) => b.gzip - a.gzip);
  return {
    chunks,
    totalGzip: chunks.reduce((sum, chunk) => sum + chunk.gzip, 0),
    totalRaw: chunks.reduce((sum, chunk) => sum + chunk.raw, 0),
    sources,
  };
};

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(2)} KB`;

/**
 * Markers that only a syntax-highlighting grammar carries: a TextMate grammar names its own
 * scope, and the scope names of the languages we ship. The word "shiki" is **not** one: the
 * loader that imports the highlighter on first use is legitimately in the initial chunk and
 * names the library and its CSS-variable prefix; what must stay out is the grammars.
 */
const GRAMMAR = /\btextmate\b|"scopeName"|source\.(?:ts|js|python|rust|go)\b/;
const LOCALE_CHUNK = /(?:^|\/)(?:en|tr)-[\w-]+\.js$/;
const MODULE_CHUNK = /^assets\/[^/]+\.js$/;
/** The push worker, an entry of its own that must stay one file (D-126). */
const WORKER = 'push-worker.js';

/** What is wrong with the initial chunks beyond their size, one sentence each. */
export const shapeProblems = (dist: string, report: Report): string[] => {
  const problems: string[] = [];
  const locales = report.chunks.filter((chunk) => LOCALE_CHUNK.test(chunk.file));
  if (locales.length > 1) {
    problems.push(
      `the initial chunks carry ${String(locales.length)} locale catalogues (${locales.map((c) => c.file).join(', ')}); only the active one may load (D-41)`,
    );
  }
  const modules = report.chunks.filter(
    (chunk) => MODULE_CHUNK.test(chunk.file) && !LOCALE_CHUNK.test(chunk.file),
  );
  if (modules.length > 1) {
    problems.push(
      `the initial modules are cut into ${String(modules.length)} files (${modules.map((c) => c.file).join(', ')}); the build keeps them in the entry, where they compress together (D-163)`,
    );
  }
  const worker = join(dist, WORKER);
  if (existsSync(worker) && /^\s*import\b|\bimport\s*\(/m.test(readFileSync(worker, 'utf8'))) {
    problems.push(
      `${WORKER} imports another file; a worker is one file of its own and shares no chunk with the page (D-126, D-163)`,
    );
  }
  for (const chunk of report.chunks) {
    if (GRAMMAR.test(readFileSync(join(dist, chunk.file), 'utf8'))) {
      problems.push(
        `${chunk.file} contains syntax-highlighting code; grammars load on first use and never in the initial chunks (D-36)`,
      );
    }
  }
  return problems;
};

/** What is wrong with where chat's code is, one sentence each: its chunk, its bounds, and the shell's sources. */
export const chatProblems = (dist: string, report: Report): string[] => {
  const problems: string[] = [];
  const assets = join(dist, 'assets');
  const [chunk] = existsSync(assets) ? readdirSync(assets).filter((f) => CHAT_CHUNK.test(f)) : [];
  if (chunk === undefined) {
    problems.push(
      "chat's screens have no chunk of their own (assets/chat-*.js); they are imported statically again, or the entry features/chat/chat.ts is gone (D-250)",
    );
  } else {
    const gzip = gzipSync(readFileSync(join(assets, chunk))).length;
    if (gzip > CHAT_BYTES) {
      problems.push(
        `assets/${chunk} is ${kb(gzip)} gzipped, over chat's ${kb(CHAT_BYTES)} bound; raise it in a commit that says what chat gained`,
      );
    }
  }
  if (report.totalGzip > SHELL_BYTES) {
    problems.push(
      `the shell is ${kb(report.totalGzip)} gzipped, over its ${kb(SHELL_BYTES)} bound; a screen that used to load later, or something new, loads first`,
    );
  }
  for (const { file } of report.chunks) {
    const sources = report.sources.get(file);
    if (sources === undefined) {
      if (file.startsWith('assets/index-')) {
        problems.push(
          `${file} has no source map, so the shell cannot be shown free of chat's screens; build it with "bun run build:web:mapped"`,
        );
      }
      continue;
    }
    const found = CHAT_ONLY_SOURCES.filter((only) =>
      sources.some(({ source }) => source.includes(`/src/${only}`)),
    );
    if (found.length > 0) {
      problems.push(
        `${file} contains chat's screens (${found.join(', ')}); they load from features/chat/chat.ts on demand and nothing in the shell may import them (D-250)`,
      );
    }
  }
  return problems;
};

export const describeReport = (report: Report, budget = BUDGET_BYTES): string => {
  const lines = [
    `initial JavaScript, gzipped: ${kb(report.totalGzip)} of ${kb(budget)} (${((report.totalGzip / budget) * 100).toFixed(0)}%)`,
    ...report.chunks.map(
      (chunk) =>
        `  ${kb(chunk.gzip).padStart(10)}  ${kb(chunk.raw).padStart(10)} raw  ${chunk.file}`,
    ),
  ];
  const largest = report.chunks[0];
  const inside = largest === undefined ? undefined : report.sources.get(largest.file);
  if (largest !== undefined && inside !== undefined && inside.length > 0) {
    lines.push(`  largest sources in ${largest.file} (by source size):`);
    for (const entry of inside.slice(0, 8))
      lines.push(`    ${kb(entry.bytes).padStart(10)}  ${entry.source}`);
  }
  return lines.join('\n');
};

/** Over budget: the reason, naming what to look at. */
export const overBudget = (report: Report, budget = BUDGET_BYTES): string | null => {
  if (report.totalGzip <= budget) return null;
  const over = report.totalGzip - budget;
  const largest = report.chunks[0];
  return [
    `the initial JavaScript is ${kb(report.totalGzip)} gzipped, ${kb(over)} over the ${kb(budget)} budget.`,
    largest === undefined ? '' : `The largest chunk is ${largest.file} (${kb(largest.gzip)}).`,
    'Something that used to load later, or something new, now loads first: a dependency imported at the top of a module the entry reaches, a route that is no longer split, a locale or grammar that is no longer lazy.',
    'The table above lists every initial chunk; build with PURLAY_SOURCEMAP=1 for the sources inside the largest.',
  ]
    .filter((line) => line !== '')
    .join('\n');
};

/** The command: what it prints, what it complains about, and whether it fails. */
export const main = (
  dist: string,
): { readonly out: string; readonly err: string; readonly code: number } => {
  const report = measure(dist);
  const problems = [...shapeProblems(dist, report), ...chatProblems(dist, report)];
  const over = overBudget(report);
  if (over !== null) problems.unshift(over);
  return {
    out: `${describeReport(report)}\n`,
    err: problems.length === 0 ? '' : `\n${problems.join('\n\n')}\n`,
    code: problems.length === 0 ? 0 : 1,
  };
};

if (import.meta.main) {
  const result = main(process.argv[2] ?? join(import.meta.dirname, '..', 'apps', 'web', 'dist'));
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exit(result.code);
}
