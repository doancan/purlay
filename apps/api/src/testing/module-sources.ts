/**
 * The production source a module's code is, and the core's: what the emission tests read to hold what a module writes to
 * what its manifest declares (`module-emissions.test.ts`, `audit-emissions.test.ts`). A module's files are its folder
 * under `features/` and, when there is one, its route file `ingress/http/<id>.ts`; the core's are every other file.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

/** The files that are the module's. */
export const sourcesOf = (id: string): string[] => {
  const route = join(API_SOURCE, 'ingress/http', `${id}.ts`);
  return production([
    ...filesUnder(join(API_SOURCE, 'features', id)),
    ...(existsSync(route) ? [route] : []),
  ]);
};

/** Every production file that is no module's: the core's, which names no module's words. */
export const coreSources = (moduleIds: readonly string[]): string[] => {
  const modules = new Set(moduleIds.flatMap(sourcesOf));
  return production(filesUnder(API_SOURCE)).filter((file) => !modules.has(file));
};

export const textOf = (files: readonly string[]): string =>
  files.map((file) => readFileSync(file, 'utf8')).join('\n');

/** A path as a reader of a failure wants it: from `apps/api/src`. */
export const shown = (file: string): string => file.replace(`${API_SOURCE}/`, '');
