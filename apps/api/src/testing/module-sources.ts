/**
 * The production source a module's code is, and the core's: what the emission tests read to hold what a module writes to
 * what its manifest declares (`module-emissions.test.ts`, `audit-emissions.test.ts`). A module's files are its folder
 * under `features/` and the files of the doors, `ingress/` and `realtime/`, that import it (its route handlers, and the frame
 * router while that runs a module's operations itself); the core's are every other file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = /\.tsx?$/;
const NOT_PRODUCTION = /\.(test|integration\.test)\.tsx?$|[\\/]testing[\\/]/;
const API_SOURCE = join(import.meta.dir, '..');

const filesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

const production = (files: readonly string[]): string[] =>
  files.filter((file) => SOURCE.test(file) && !NOT_PRODUCTION.test(file));

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** The ids of the features a source imports a path through: `from '…/features/chat/…'`, `import('…')`, `export … from`. */
export const featuresImportedBy = (source: string): string[] => {
  const ids = [
    ...withoutComments(source).matchAll(
      /(?:\bfrom\s*|\bimport\s*\(?\s*)['"][^'"]*\bfeatures\/([a-z0-9-]+)(?:\/[^'"]*)?['"]/g,
    ),
  ].map((found) => found[1] ?? '');
  return [...new Set(ids)].sort();
};

/**
 * The ways a feature's source gets round the import fences, each as the text of it: a dynamic `import()`, `require`, a loader
 * of its own, and a specifier that climbs into `packages/` or `apps/` instead of naming the package. The lint says the
 * same (`eslint.config.mjs`); this reads the text as well, so the guard does not rest on one tool. Comments are not read.
 */
export const fenceBypassesIn = (source: string): string[] => {
  const code = withoutComments(source);
  const found = [
    [/\bimport\s*\(/, 'a dynamic import()'],
    [/\brequire\s*\(|\.require\b/, 'require'],
    [/\bcreateRequire\b|\bfrom\s*['"](node:)?module['"]/, 'a loader of its own'],
    [/\bfrom\s*['"][^'"]*\/(packages|apps)\/[^'"]*['"]/, 'a path into packages/ or apps/'],
  ] as const;
  return found.filter(([pattern]) => pattern.test(code)).map(([, name]) => name);
};

/** The files of the core a source imports by a path, as `platform/clock`: what `scripts/module-reach.mjs` opens or refuses. */
export const coreImportsOf = (source: string): string[] => [
  ...new Set(
    [
      ...withoutComments(source).matchAll(
        /\bfrom\s*['"](?:\.\.\/)+((?:platform|modules|ingress|realtime)\/[^'"]+)['"]/g,
      ),
    ].map((found) => found[1] ?? ''),
  ),
];

/** The production files of a feature's own folder: not the doors' files that import it. */
export const featureSources = (id: string): string[] =>
  production(filesUnder(join(API_SOURCE, 'features', id)));

/** The folders whose files are the doors: where a request or a frame arrives and is routed. */
const DOORS = ['ingress', 'realtime'] as const;

/** The one file that registers every module's routes: it names them all and is no module's. */
const COMPOSITION_ROOT = join(API_SOURCE, 'ingress/http/app.ts');

/** The files of a door that import the module: its route handlers, found by what they import and not by a list. */
const doorFilesOf = (id: string): string[] =>
  production(DOORS.flatMap((door) => filesUnder(join(API_SOURCE, door)))).filter(
    (file) =>
      file !== COMPOSITION_ROOT && featuresImportedBy(readFileSync(file, 'utf8')).includes(id),
  );

/** The files that are the module's. */
export const sourcesOf = (id: string): string[] =>
  production([...filesUnder(join(API_SOURCE, 'features', id)), ...doorFilesOf(id)]);

/** Every production file that is no module's: the core's, which names no module's words. */
export const coreSources = (moduleIds: readonly string[]): string[] => {
  const modules = new Set(moduleIds.flatMap(sourcesOf));
  return production(filesUnder(API_SOURCE)).filter((file) => !modules.has(file));
};

export const textOf = (files: readonly string[]): string =>
  files.map((file) => readFileSync(file, 'utf8')).join('\n');

/** A path as a reader of a failure wants it: from `apps/api/src`. */
export const shown = (file: string): string => file.replace(`${API_SOURCE}/`, '');
