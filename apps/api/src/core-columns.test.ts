/**
 * The columns of core tables that exist for one module are listed, capped and held (`MODULES.md` §5, D-275).
 *
 * `CORE_COLUMNS_FOR_A_MODULE` (`@purlay/db`) names each, with the module and why, and the core files that may name it. A
 * column on a core table used by a single module is acceptable only if it is there; this holds the list to the schema
 * and to the code:
 *
 * - every entry is a column of a core table, for a module the build carries, with a reason, and **the list is as long as
 *   `CAP` says, so it only shrinks**: an entry added fails here until a decision raises the cap, which is the line a
 *   reviewer reads;
 * - a file of the core that names a listed column outside its entry's files fails, and so does a file of another module
 *   (a column a second module wants is not one module's, and moves to a table of its own or to the core's port);
 * - an entry whose file no longer names the column fails, so the allow-list shrinks with the code;
 * - a module's migration set adds no column to a core table (`migration-cells.integration.test.ts` holds the same against
 *   the database, and this holds it with no database), except the links `CORE_COLUMNS_A_SET_CHANGES` names.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { CORE_COLUMNS_A_SET_CHANGES, CORE_COLUMNS_FOR_A_MODULE, TABLE_OWNERS } from '@purlay/db';
import { bundledModules } from './composition';
import { coreSources, shown, sourcesOf } from './testing/module-sources';

/** How many columns may be listed. Lower it with the entry that goes; raising it is a decision (D-275). */
const CAP = 9;

const DB_ROOT = join(import.meta.dir, '../../../packages/db');
const moduleIds = bundledModules.map(({ manifest }) => manifest.id);
const coreTables = Object.entries(TABLE_OWNERS)
  .filter(([, owner]) => owner === 'core')
  .map(([table]) => table);

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const withoutSqlComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');

const names = (source: string, column: string): boolean =>
  new RegExp(String.raw`\b${column}\b`).test(withoutComments(source));

const entries = Object.entries(CORE_COLUMNS_FOR_A_MODULE).map(([key, entry]) => {
  const [table = '', column = ''] = key.split('.');
  return { key, table, column, ...entry };
});

/** The columns each core table has, read from the generated types. */
const columnsOf = (table: string): string[] => {
  const types = readFileSync(join(DB_ROOT, 'src/schema.ts'), 'utf8');
  const pascal = table
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  const body = new RegExp(String.raw`export interface ${pascal} \{([\s\S]*?)\n\}`).exec(types)?.[1];
  return [...(body ?? '').matchAll(/^\s+(\w+)\??:/gm)].map((found) => found[1] ?? '');
};

/** Core tables' columns that a module's migration sets add, as `table.column`. */
const columnsAddedByModuleSets = (
  migrations: ReadonlyMap<string, string>,
  tables: readonly string[],
): string[] =>
  [...migrations.values()].flatMap((sql) =>
    [
      ...withoutSqlComments(sql).matchAll(
        /alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?(?:public\.)?(\w+)([^;]*);/gi,
      ),
    ]
      .filter(([, table]) => tables.includes(table ?? ''))
      .flatMap(([, table, body]) =>
        [...(body ?? '').matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)].map(
          (added) => `${table ?? ''}.${added[1] ?? ''}`,
        ),
      ),
  );

const moduleMigrations = (): Map<string, string> => {
  const root = join(DB_ROOT, 'migrations');
  return new Map(
    readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((set) =>
        readdirSync(join(root, set.name))
          .filter((file) => file.endsWith('.sql'))
          .map((file): [string, string] => [
            `${set.name}/${file}`,
            readFileSync(join(root, set.name, file), 'utf8'),
          ]),
      ),
  );
};

describe('the columns of core tables that exist for a module', () => {
  test('are as many as the cap says, each of a core table, for a module the build carries, with a reason', () => {
    expect(entries.length).toBe(CAP);
    for (const { key, table, column, module, why } of entries) {
      expect(coreTables, `${key}: ${table} is not a core table`).toContain(table);
      expect(columnsOf(table), `${key}: ${table} has no column ${column}`).toContain(column);
      expect(moduleIds, `${key}: ${module} is not a module of this build`).toContain(module);
      expect(why.trim(), `${key} has no reason`).not.toBe('');
    }
  });

  test('are named, in the core, by the files of their entry and by no other', () => {
    for (const file of coreSources(moduleIds)) {
      const source = readFileSync(file, 'utf8');
      for (const { key, column, coreFiles } of entries) {
        if (!names(source, column)) continue;
        expect(coreFiles, `${shown(file)} names ${key}, which is for a module`).toContain(
          shown(file),
        );
      }
    }
  });

  test('are named by no module but their own', () => {
    for (const id of moduleIds) {
      for (const file of sourcesOf(id)) {
        const source = readFileSync(file, 'utf8');
        for (const { key, column, module } of entries) {
          if (module === id || !names(source, column)) continue;
          expect(false, `${shown(file)} names ${key}, which is for ${module}`).toBe(true);
        }
      }
    }
  });

  test('are named by every core file their entry lists, so the list of files shrinks with the code', () => {
    for (const { key, column, coreFiles } of entries) {
      for (const file of coreFiles) {
        const source = readFileSync(join(import.meta.dir, file), 'utf8');
        expect(
          names(source, column),
          `${file} no longer names ${key}: remove it from the entry`,
        ).toBe(true);
      }
    }
  });

  test('are not added to by a module’s migrations, which make tables of their own', () => {
    expect(
      columnsAddedByModuleSets(moduleMigrations(), coreTables).filter(
        (added) => !CORE_COLUMNS_A_SET_CHANGES.includes(added),
      ),
    ).toEqual([]);
  });

  test('the scan of a module’s migrations sees an added column of a core table, in the shapes SQL spells it', () => {
    const sql = new Map([
      ['a.sql', 'ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname text;'],
      [
        'b.sql',
        'alter table only public.workspaces\n  add column theme text,\n  add column tint text;',
      ],
      [
        'c.sql',
        '-- ALTER TABLE users ADD COLUMN ignored text;\nALTER TABLE issues ADD COLUMN own text;',
      ],
      ['d.sql', 'ALTER TABLE users DROP COLUMN old;'],
    ]);
    expect(columnsAddedByModuleSets(sql, ['users', 'workspaces'])).toEqual([
      'users.nickname',
      'workspaces.theme',
      'workspaces.tint',
    ]);
  });
});
