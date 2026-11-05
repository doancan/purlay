/**
 * Which modules a test suite needs (`MODULES.md` §8): the one rule that decides which suites a cell of the matrix runs.
 *
 * A suite that is about no module's behaviour must pass whichever modules a process runs, so CI runs it in every cell
 * (`module-suites.ts`). A suite that needs a module — it reads the module's code, or its tables, or asks its routes — can
 * only run in a cell that has the module, and is left out of the others with the reason said. What a suite needs is the
 * union of two things, neither of which is a list of suites kept by hand:
 *
 * - **what it imports**: any file of `features/<id>/` in its closure of relative imports (the test's own helpers
 *   included, so a fixture that builds a channel makes every suite that uses it need chat), stopping at the files that
 *   name every module by design because they are where the modules are put together (`COMPOSITION_ROOTS`);
 * - **what it declares**: a line `// @needs-modules chat, issues` in the file or in a helper it imports, for a need an import
 *   does not show — a suite that asks a module's routes through the application, or reads its tables, imports nothing of the
 *   module. A fixture that writes a module's rows says so once and every suite that uses it needs the module.
 *
 * A suite that needs a module and says nothing fails in the cells without it, in CI, with the module's tables or routes
 * missing; a module added to the build is a new id here with no suite edited, and the suites that import it are its.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const API_SOURCE = resolve(import.meta.dir, '..');

/**
 * Files that name every module because they put the modules together: the composition, the application's routes, the
 * socket, the process's entry. A suite that imports one does not thereby need a module — what it asks of the modules
 * is declared. Relative to `apps/api/src`.
 */
const COMPOSITION_ROOTS: readonly string[] = [
  'composition.ts',
  'index.ts',
  join('ingress', 'http', 'app.ts'),
  join('ingress', 'ws', 'socket.ts'),
];

const DECLARATION = /^[ \t]*(?:\/\/|\*)[ \t]*@needs-modules[ \t]+(.+?)[ \t]*$/gm;

/** The modules a source declares it needs: `// @needs-modules chat, issues`. */
export const declaredNeeds = (source: string): readonly string[] =>
  [...source.matchAll(DECLARATION)].flatMap((found) =>
    (found[1] ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
  );

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** A type-only import is erased: the code it names is not loaded, so it is not a need. */
const withoutTypeImports = (source: string): string =>
  source.replace(/\b(?:import|export)\s+type\s[^;]*?\bfrom\s*['"][^'"]*['"]/g, '');

/** The relative paths a source loads: imported, dynamically imported and re-exported, but not the types alone. */
export const relativeImports = (source: string): readonly string[] =>
  [
    ...withoutTypeImports(withoutComments(source)).matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]*)['"]/g,
    ),
  ].map((found) => found[1] ?? '');

const resolveImport = (from: string, path: string): string | undefined => {
  const base = resolve(dirname(from), path);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
};

/** The module whose folder a file is in, when the file is under `features/<id>/` of the API. */
const moduleOwning = (file: string, ids: readonly string[]): string | undefined => {
  const parts = relative(join(API_SOURCE, 'features'), file).split(/[\\/]/);
  const [id] = parts;
  return parts[0] !== '..' && id !== undefined && ids.includes(id) ? id : undefined;
};

/** The modules a suite needs, sorted: what it imports, and what it declares. */
export type NeedsOf = (file: string) => readonly string[];

/** A reader over the modules a build carries (`ids`), for the files of one checkout. */
export const needsReader = (ids: readonly string[]): NeedsOf => {
  // A helper is imported by hundreds of suites and its imports do not change while one run reads them.
  const edges = new Map<string, readonly string[]>();
  const edgesOf = (file: string): readonly string[] => {
    const known = edges.get(file);
    if (known !== undefined) return known;
    const isRoot = COMPOSITION_ROOTS.some((root) => join(API_SOURCE, root) === file);
    const next = isRoot
      ? []
      : relativeImports(readFileSync(file, 'utf8')).flatMap(
          (path) => resolveImport(file, path) ?? [],
        );
    edges.set(file, next);
    return next;
  };
  return (file) => {
    const reached = new Set<string>([file]);
    const queue = [file];
    for (const current of queue) {
      for (const next of edgesOf(current)) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    const needed = new Set<string>();
    for (const reachedFile of reached) {
      for (const id of declaredNeeds(readFileSync(reachedFile, 'utf8'))) needed.add(id);
      const owner = moduleOwning(reachedFile, ids);
      if (owner !== undefined) needed.add(owner);
    }
    return [...needed].toSorted();
  };
};
