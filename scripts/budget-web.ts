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
 * push worker in one of its own (D-163), and no module's screen among them: a module is a chunk of its own, so a
 * server that does not run it never asks for it (D-250). Each is cheap to break and invisible until the
 * number moves.
 *
 * **The shell holds no module's screen** (D-250, `docs/MODULES.md` §6): a module's screens are a chunk of their own,
 * which the shell asks for with `import()` and which is not initial — chat's `assets/chat-*.js`, issues'
 * `assets/issues-screen-*.js`. The modules and their entries are read from the manifests (`load: () => import('./x')`),
 * so a module added later is held without a line here, and its files are derived from its folder (`screenSources`, D-277); one with no bound in `MODULE_BYTES` fails. The check reads
 * the source maps of the initial chunks, so it needs `bun run build:web:mapped`, and fails — rather than passing
 * unproven — when there is none. A bound goes with each chunk, and one with the shell's, set from the measured build
 * with a margin for a feature or two: the shell's 257 KB (2026-11-03: 242.04 KB gzipped, set at 250; 2026-11-07: 250.07 KB with the find's and the inbox's shared contract types, so raised by 6; 2026-11-11: owned departure probes measured 256.58 KB and incoming webhook setup/test contracts bring the combined build to 256.85 KB, within the one KB added) so the 400 KB
 * backstop above is no longer what catches a screen that crept back; chat's 52 KB (45.65 KB, 10% above, set at 50; 2026-11-10: 50.12 KB, raised by 2, since the composer and the feed were split into units that each have a reason to change, which costs 0.8 KB gzipped of structure — hook results, props handed across, one shared popover — and gives no screen anything new); issues' 3 KB
 * (2026-11-06: 2.70 KB, 11% above). They move up in a commit that says why, as the backstop does.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CORE_IMPORTS_OF_MODULES } from './web-fences.mjs';
import { staticClosure, webImports, type WebImport } from './web-imports';

export const BUDGET_BYTES = 400 * 1024;
/** The shell's own bound: the initial JavaScript with chat's screens in their own chunk. */
export const SHELL_BYTES = 257 * 1024;
/**
 * Each module's chunk, gzipped, by the id of its manifest: chat's is the screens, the composer, the feed and the threads.
 * A module without a bound fails the check, so a bound is chosen when a module is added, with a margin of about a tenth.
 */
export const MODULE_BYTES: Readonly<Record<string, number>> = {
  chat: 52 * 1024,
  issues: 3 * 1024,
};

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
/**
 * What a module's lazy screen carries that nothing else does, by the id in the module's manifest (`MODULES.md` §6,
 * D-254): found in an initial chunk, the module is no longer a chunk of its own. The word is not in the manifest, which
 * the shell does carry: it is in the screen's file, as `ISSUES_SCREEN` is, and a module with a manifest is
 * looked for without a line here. (Every file of a module is also looked for by its source, `screenSources`.)
 */
const screenMarker = (moduleId: string): string => `screen-of-the-${moduleId}-module`;

const SRC = join(import.meta.dirname, '..', 'apps', 'web', 'src');
const FEATURES = join(SRC, 'features');

/** A module of the client: the id its manifest declares, and the file its `load` imports, as a path under `features/`. */
export interface WebModule {
  readonly id: string;
  readonly folder: string;
  /** Without the extension, as the manifest writes it: `import('./chat')` is `chat/chat`; none when `load` is not that. */
  readonly entry: string | undefined;
}

/** Every `features/<folder>/manifest.ts` and what it declares: the `id`, and the `import('./x')` of `load`. */
export const webModules = (features = FEATURES): WebModule[] =>
  readdirSync(features).flatMap((folder) => {
    const manifest = join(features, folder, 'manifest.ts');
    if (!existsSync(manifest)) return [];
    const text = readFileSync(manifest, 'utf8');
    const id = /^\s*id: '([\w-]+)',$/m.exec(text)?.[1];
    if (id === undefined) throw new Error(`${manifest} declares no \`id: '…'\` line`);
    const loaded = /\bload:\s*\(\)\s*=>\s*import\('\.\/([\w-]+)'\)/.exec(text)?.[1];
    return [{ id, folder, entry: loaded === undefined ? undefined : `${folder}/${loaded}` }];
  });

/** The ids of the modules whose manifests are in the client. */
export const moduleIds = (features = FEATURES): string[] =>
  webModules(features).map((module) => module.id);

/**
 * The files of a module that no initial chunk may hold, as paths under `src/` (D-277): everything in its folder but the
 * manifest and the tests, less what the core is allowed to import (`CORE_IMPORTS_OF_MODULES`) and what those files import
 * statically, which is in the shell for the reason listed there. Derived from the folder, so a file added to a module is
 * held without a line here, and a file the core stops importing is held from then on.
 */
export const screenSources = (
  module: WebModule,
  imports: readonly WebImport[] = webImports(SRC),
): string[] => {
  const resident = staticClosure(
    imports,
    CORE_IMPORTS_OF_MODULES.map(({ to }) => to),
  );
  const files = new Set(imports.flatMap(({ from, to }) => [from, to]));
  return [...files]
    .filter(
      (file) =>
        file.startsWith(`features/${module.folder}/`) &&
        file !== `features/${module.folder}/manifest.ts` &&
        !/\.test\.tsx?$/.test(file) &&
        !resident.has(file),
    )
    .sort();
};

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
  const ids = moduleIds();
  for (const chunk of report.chunks) {
    const text = readFileSync(join(dist, chunk.file), 'utf8');
    for (const module of ids) {
      const marker = screenMarker(module);
      if (text.includes(marker)) {
        problems.push(
          `${chunk.file} contains the ${module} module's screen; a module loads as a chunk of its own and the shell never carries it (D-250)`,
        );
      }
    }
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

/**
 * What is wrong with where each module's code is, and with the shell's size, one sentence each: a module's chunk and its
 * bound, and its sources in the shell.
 */
export const moduleProblems = (
  dist: string,
  report: Report,
  features = FEATURES,
  imports?: readonly WebImport[],
): string[] => {
  const problems: string[] = [];
  const assets = join(dist, 'assets');
  const files = existsSync(assets) ? readdirSync(assets) : [];
  const modules = webModules(features);
  // The import graph is read once, when a chunk with a source map first needs it, and not for each chunk and module.
  let graph = imports;
  const lazyOnly: Record<string, string[]> = {};
  for (const module of modules) {
    const bound = MODULE_BYTES[module.id];
    if (bound === undefined) {
      problems.push(
        `the ${module.id} module has no bound for its chunk; add it to MODULE_BYTES, about a tenth above what the build measures`,
      );
    }
    if (module.entry === undefined) {
      problems.push(
        `the ${module.id} module's manifest does not load its screens with \`load: () => import('./…')\`, so its chunk cannot be found`,
      );
      continue;
    }
    const base = module.entry.split('/')[1] ?? '';
    const chunk = files.find((file) => new RegExp(`^${base}-[\\w-]+\\.js$`).test(file));
    if (chunk === undefined) {
      problems.push(
        `the ${module.id} module's screens have no chunk of their own (assets/${base}-*.js); they are imported statically again, or the entry features/${module.entry} is gone (D-250)`,
      );
      continue;
    }
    const gzip = gzipSync(readFileSync(join(assets, chunk))).length;
    if (bound !== undefined && gzip > bound) {
      problems.push(
        `assets/${chunk} is ${kb(gzip)} gzipped, over the ${module.id} module's ${kb(bound)} bound; raise it in a commit that says what ${module.id} gained`,
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
          `${file} has no source map, so the shell cannot be shown free of the modules' screens; build it with "bun run build:web:mapped"`,
        );
      }
      continue;
    }
    for (const module of modules) {
      const own = (lazyOnly[module.id] ??= screenSources(module, (graph ??= webImports(SRC))));
      const found = own.filter((only) =>
        sources.some(({ source }) => source.includes(`/src/${only}`)),
      );
      if (found.length > 0) {
        problems.push(
          `${file} contains the ${module.id} module's code (${found.slice(0, 4).join(', ')}${found.length > 4 ? `, and ${String(found.length - 4)} more` : ''}); it loads from the module's chunk, features/${module.entry ?? module.folder}, on demand and nothing in the shell may import it (D-250, D-277)`,
        );
      }
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
  imports?: readonly WebImport[],
): { readonly out: string; readonly err: string; readonly code: number } => {
  const report = measure(dist);
  const problems = [
    ...shapeProblems(dist, report),
    ...moduleProblems(dist, report, FEATURES, imports),
  ];
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
