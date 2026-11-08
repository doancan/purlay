/**
 * A module names only its own tables and the core tables it reads (D-271, `MODULES.md` §4, §8): what the typed handle
 * cannot see, the text of a raw `sql` template, a column written `table.column`, a table given to `tableExists`, is read
 * here, for every folder under `features/`. The tables come from `TABLE_OWNERS` and `features/<id>/schema.ts`, so a module
 * added later is held without this file being told, and a module with no `schema.ts` fails.
 *
 * A module that **writes** a core table says so in `CORE_WRITES`, each with why: a write into the core's rows is a seam that
 * is not a port yet, and the list may only shrink. Reads are not told from writes by the type, which is why this does.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { TABLE_OWNERS } from '@purlay/db';
import { FACTS } from '@purlay/types';
import { shown, sourcesOf } from './testing/module-sources';
import {
  coreWrites,
  foreignUses,
  tablesNamed,
  unsaidCoreWrites,
  withoutFactTypes,
} from './testing/module-tables';

const FEATURES = join(import.meta.dir, 'features');

/**
 * Where a module writes a core table, by file and table, with why and what would remove it. **It may only shrink**: an
 * entry whose file no longer writes the table fails the test.
 */
const CORE_WRITES: Readonly<Record<string, string>> = {
  'features/chat/messages/messages.ts:attachments':
    'a sent file is claimed by the message that carries it (`AttachmentOwner` could own it)',
  'features/chat/scheduled/scheduled.ts:attachments':
    'a scheduled message claims the upload it will send (`AttachmentOwner` could own it)',
  'features/chat/messages/messages.ts:workspaces':
    'a message adds its files to the workspace’s `storage_used_bytes` (`platform/quota` could own it)',
  'features/chat/notifications/missed-mail.ts:users':
    'missed mail moves the person’s `missed_mail_since` (a core preference port could own it)',
};

/**
 * The size `CORE_WRITES` may have. The list only shrinks, but "an entry is still a write" cannot see one being added; this
 * can. A write joins it only with this raised in the same change, a line a reviewer reads and has to accept.
 */
const MAX_CORE_WRITES = 4;

const TABLES = Object.keys(TABLE_OWNERS);
const moduleIds = readdirSync(FEATURES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const coreTables = Object.entries(TABLE_OWNERS)
  .filter(([, owner]) => owner === 'core')
  .map(([table]) => table);

const ownTablesOf = (id: string): string[] =>
  Object.entries(TABLE_OWNERS)
    .filter(([, owner]) => owner === id)
    .map(([table]) => table);

const readCoreReads = async (id: string): Promise<readonly string[]> => {
  if (!existsSync(join(FEATURES, id, 'schema.ts'))) {
    throw new Error(
      `features/${id} has no schema.ts (D-271, MODULES.md §9): a module says which core tables it reads and makes its handle there`,
    );
  }
  const schema = (await import(join(FEATURES, id, 'schema.ts'))) as {
    CORE_READS?: readonly string[];
  };
  if (schema.CORE_READS === undefined) {
    throw new Error(
      `features/${id}/schema.ts exports no CORE_READS (D-271): it says which core tables ${id} reads`,
    );
  }
  return schema.CORE_READS;
};

describe('what the scan sees', () => {
  const names = ['users', 'issues', 'channels', 'messages'];
  const seen = (source: string): string[] => tablesNamed(source, names).map((use) => use.table);

  test('a table in each place a statement puts one', () => {
    for (const [source, table] of [
      ["db.selectFrom('channels as c')", 'channels'],
      ["db.insertInto('issues').values(row)", 'issues'],
      ['db\n  .deleteFrom(`channels`)', 'channels'],
      ["q.innerJoin('channels as c', 'c.id', 'n.channel_id')", 'channels'],
      ['await sql`delete from messages where id = ${id}`', 'messages'],
      ['sql<number>`select count(*) from public.issues`', 'issues'],
      ["eb.ref('channels.id')", 'channels'],
      ["sql.ref('issues.id')", 'issues'],
      ["type Row = Database['issues'];", 'issues'],
      ["await tableExists(transaction, 'issues')", 'issues'],
      ['sql`select ${sql`1`} from channels`', 'channels'],
      ['sql`select ${`${a}`} from channels`', 'channels'],
    ] as const) {
      expect(seen(source), source).toEqual([table]);
    }
  });

  test('and nothing in a path, a field, a word or a comment', () => {
    for (const source of [
      "'/api/channels/:channelId/messages'",
      "const RESERVED = new Set(['channels', 'messages']);",
      "// .selectFrom('channels') in a comment",
      '/* delete from channels */ const x = 1;',
      'const done = { messages: 0 }; done.messages += 1;',
      "const text = 'select from channels';",
      'sql`select 1`; const channels = 1;',
      "sql`select 1 for update`; db.selectFrom('other')",
    ]) {
      expect(seen(source), source).toEqual([]);
    }
  });

  test('a write is told from a read, and a line is the file’s', () => {
    const source = [
      "db.selectFrom('users');",
      '// a comment',
      "db.updateTable('users').set({});",
      'sql`',
      '  insert into users values (1)`;',
    ].join('\n');
    expect(tablesNamed(source, ['users'])).toEqual([
      { table: 'users', line: 1, write: false },
      { table: 'users', line: 3, write: true },
      { table: 'users', line: 5, write: true },
    ]);
  });

  test('a fact type is not a table’s column, though a module’s id is its table’s name', () => {
    const source =
      "consumes: ['issues.assigned'],\npublishes: ['issues.closed'],\neb.ref('issues.id')";
    expect(seen(source)).toEqual(['issues', 'issues', 'issues']);
    expect(seen(withoutFactTypes(source, ['issues.assigned', 'issues.closed']))).toEqual([
      'issues',
    ]);
  });

  test('a foreign table is one the module neither owns nor reads', () => {
    const source = "db.selectFrom('issues'); sql`select 1 from channels`; db.selectFrom('users');";
    expect(foreignUses(source, names, ['issues', 'users']).map((use) => use.table)).toEqual([
      'channels',
    ]);
    expect(foreignUses(source, names, ['issues', 'users', 'channels'])).toEqual([]);
  });

  test('a write of a core table is found by the builder and by raw SQL', () => {
    const source =
      "db.updateTable('users'); sql`update workspaces set x = 1`; db.selectFrom('sessions');";
    expect(coreWrites(source, ['users', 'workspaces', 'sessions']).map((use) => use.table)).toEqual(
      ['users', 'workspaces'],
    );
  });

  test('a write that is not said is reported, and one that is said is not', () => {
    const source =
      "db.updateTable('users'); db.deleteFrom('workspaces'); db.selectFrom('sessions');";
    const core = ['users', 'workspaces', 'sessions'];
    expect(unsaidCoreWrites(source, core, () => false).map((use) => use.table)).toEqual([
      'users',
      'workspaces',
    ]);
    expect(
      unsaidCoreWrites(source, core, (table) => table === 'users').map((use) => use.table),
    ).toEqual(['workspaces']);
    expect(unsaidCoreWrites(source, core, () => true)).toEqual([]);
  });
});

describe('the tables a module names', () => {
  test('are found: every folder under features, with its tables from the owners list', () => {
    expect(moduleIds).toContain('chat');
    expect(moduleIds).toContain('issues');
    expect(ownTablesOf('issues')).toEqual(['issues']);
    expect(ownTablesOf('chat')).toContain('messages');
    expect(coreTables).toContain('users');
  });

  for (const id of moduleIds) {
    describe(id, () => {
      test('says which core tables it reads, and they are the core’s', async () => {
        const reads = await readCoreReads(id);
        for (const table of reads) expect(coreTables, table).toContain(table);
        expect(new Set(reads).size).toBe(reads.length);
      });

      for (const file of sourcesOf(id)) {
        test(`${shown(file)} names no table that is not its own or one it reads`, async () => {
          const allowed = [...ownTablesOf(id), ...(await readCoreReads(id))];
          const source = withoutFactTypes(
            readFileSync(file, 'utf8'),
            FACTS.map((fact) => fact.type),
          );
          expect(
            foreignUses(source, TABLES, allowed).map(
              (use) => `${shown(file)}:${String(use.line)} ${use.table}`,
            ),
          ).toEqual([]);
        });

        test(`${shown(file)} writes no core table it has not said it writes`, () => {
          const source = readFileSync(file, 'utf8');
          const unsaid = unsaidCoreWrites(
            source,
            coreTables,
            (table) => `${shown(file)}:${table}` in CORE_WRITES,
          );
          expect(
            unsaid.map((use) => `${shown(file)}:${String(use.line)} writes ${use.table}`),
          ).toEqual([]);
        });
      }
    });
  }

  test('the list of writes is no longer than its cap', () => {
    expect(Object.keys(CORE_WRITES).length).toBeLessThanOrEqual(MAX_CORE_WRITES);
  });

  test('an entry of the list of writes is still a write, so the list only shrinks', () => {
    for (const entry of Object.keys(CORE_WRITES)) {
      const [file, table] = entry.split(':');
      const source = readFileSync(join(import.meta.dir, file ?? ''), 'utf8');
      expect(
        coreWrites(source, coreTables).some((use) => use.table === table),
        `${entry} is no longer a write: remove it from CORE_WRITES`,
      ).toBe(true);
    }
  });
});
