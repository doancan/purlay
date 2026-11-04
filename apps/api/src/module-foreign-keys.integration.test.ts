/**
 * A foreign key from one module's table to another's makes the first need the second's tables, so its manifest must say
 * it `requires` that module (D-250, `MODULES.md` §5). The core is the exception: every module may point at it.
 * `table-owners.ts` holds the keys to the database; nothing else tied them to the manifests.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, integrationDatabase, sql, TABLE_OWNERS } from '@purlay/db';
import { bundledModules } from './composition';

const owners: Readonly<Record<string, string>> = TABLE_OWNERS;

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: a foreign key between modules and what the manifests require', () => {
  test('the module whose table holds the key requires the module whose table it points at', async () => {
    const { rows } = await sql<{ child: string; parent: string }>`
      select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
      from pg_constraint c
      where c.contype = 'f' and c.connamespace = current_schema()::regnamespace`.execute(
      integrationDatabase(),
    );
    const requiresOf = new Map<string, readonly string[]>(
      bundledModules.map((module) => [module.manifest.id, module.manifest.requires]),
    );
    const unrequired: string[] = [];
    for (const { child, parent } of rows) {
      const from = owners[child];
      const to = owners[parent];
      if (from === undefined || to === undefined) continue;
      if (from === 'core' || to === 'core' || from === to) continue;
      if (requiresOf.get(from)?.includes(to) !== true) {
        unrequired.push(`${child} (${from}) -> ${parent} (${to})`);
      }
    }
    expect(
      [...new Set(unrequired)].sort(),
      'A foreign key between two modules needs the first module to list the second in `requires`; or drop the key.',
    ).toEqual([]);
  });
});
