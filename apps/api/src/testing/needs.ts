/**
 * What a test says it needs of the modules a process runs (`module-needs.ts`, `MODULES.md` §8).
 *
 * The harness reads `MODULES` (`@purlay/db`'s `testing.ts` migrates the sets it names, `testDependencies` composes the
 * modules it names), so the same suite runs in each cell of the matrix. A whole file that needs a module says so with a
 * `// @needs-modules chat` line, which the cell runner reads to leave the file out. A single test or group in a file that
 * is otherwise about no module is written with `testNeeding('chat')` and is skipped, under a name that says why, in a cell
 * without it.
 */
import { describe, test } from 'bun:test';
import { bundledModules } from '../composition';
import { runComposition } from './run-composition';

const running = (ids: readonly string[]): boolean => {
  const carried = bundledModules.map((module) => module.manifest.id);
  const unknown = ids.filter((id) => !carried.includes(id));
  if (unknown.length > 0)
    throw new Error(`no module of this build is called ${unknown.join(', ')}`);
  return ids.every((id) => runComposition.modules.some((module) => module.manifest.id === id));
};

const named = (name: string, ids: readonly string[]): string =>
  `${name} (needs ${ids.join(' + ')})`;

/** `test`, skipped in a cell that does not run every module named. */
export const testNeeding =
  (...ids: readonly string[]) =>
  (name: string, body: () => void | Promise<void>, timeout?: number): void => {
    test.skipIf(!running(ids))(named(name, ids), body, timeout);
  };

/** `describe`, skipped in a cell that does not run every module named. */
export const describeNeeding =
  (...ids: readonly string[]) =>
  (name: string, body: () => void): void => {
    describe.skipIf(!running(ids))(named(name, ids), body);
  };
