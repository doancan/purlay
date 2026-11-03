/**
 * The build's modules and its migration sets are two lists nothing links in code (`composition.ts` carries the modules,
 * `@purlay/db` the sets, `migrations/<id>/` the files), so this is what does: a module that has a directory of migrations
 * has a registered set, and a set or a directory is some bundled module's (D-250, `MODULES.md` §5). Without it a module
 * whose set was forgotten in `PRODUCT_MIGRATION_SETS` would never be migrated, and its tables would be missing from a
 * database that runs it.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { MIGRATIONS_DIRECTORY, PRODUCT_MIGRATION_SETS, TABLE_OWNERS } from '@purlay/db';
import { bundledModules } from './composition';

const moduleIds = bundledModules.map((module) => module.manifest.id);
const setIds: readonly string[] = PRODUCT_MIGRATION_SETS.map((set) => set.id);

const subdirectories = (): string[] =>
  readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const sqlFilesIn = (directory: string): string[] =>
  readdirSync(directory).filter((name) => name.endsWith('.sql'));

describe('the migration sets and the modules of the build', () => {
  test('every directory under migrations/ is the registered set of a bundled module', () => {
    for (const directory of subdirectories()) {
      expect({ directory, registered: setIds.includes(directory) }).toEqual({
        directory,
        registered: true,
      });
      expect({ directory, bundled: moduleIds.includes(directory) }).toEqual({
        directory,
        bundled: true,
      });
    }
  });

  test('every registered set is a bundled module’s, in a directory of its own that holds migrations', () => {
    expect(setIds.length).toBeGreaterThan(0);
    for (const set of PRODUCT_MIGRATION_SETS) {
      expect({ set: set.id, bundled: moduleIds.includes(set.id) }).toEqual({
        set: set.id,
        bundled: true,
      });
      expect(set.directory).toBe(join(MIGRATIONS_DIRECTORY, set.id));
      expect({ set: set.id, files: sqlFilesIn(set.directory).length > 0 }).toEqual({
        set: set.id,
        files: true,
      });
    }
  });

  test('every bundled module that owns a table has its set registered, and no set is registered twice', () => {
    const owners = new Set(Object.values<string>(TABLE_OWNERS));
    owners.delete('core');
    for (const owner of owners) {
      expect({ owner, bundled: moduleIds.includes(owner) }).toEqual({ owner, bundled: true });
      expect({ owner, registered: setIds.includes(owner) }).toEqual({ owner, registered: true });
    }
    expect(new Set(setIds).size).toBe(setIds.length);
  });
});
