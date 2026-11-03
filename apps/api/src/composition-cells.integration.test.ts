/**
 * The core's erasure, purge and exports on a database each cell of the matrix made (D-250, D-254): the core alone, each
 * module alone, and everything. A module with a set of its own is held only while it runs, so where issues was never
 * migrated its table is not there and nothing the core does may reach for it; where it was, its rows are erased, purged
 * and exported like any other. A cell is a database migrated with the sets its composition names, ready, and then used.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, sql, type Executor } from '@purlay/db';
import { compose, compositionFor, type Composition } from './composition';
import { issuesModule } from './features/issues/module';
import { exportWorkspace } from './modules/export/export';
import { exportPerson } from './modules/export/personal';
import { purgeWorkspaceContent } from './modules/workspaces/deletion-purge';
import { fixedClock } from './platform/clock';
import { migrateOnStart } from './platform/migrate-on-start';
import { readiness } from './platform/readiness';
import { atomicallyOn } from './platform/transactions';
import { aRecordingLogger } from './testing/doubles';
import { aMemoryStore } from './testing/storage';

const source = process.env['DATABASE_URL'];
if (source === undefined || source === '') {
  throw new Error('DATABASE_URL is not set, so these tests would silently prove nothing.');
}

const urlFor = (name: string): string => {
  const url = new URL(source);
  url.pathname = `/${name}`;
  return url.toString();
};

const BASE = `${new URL(source).pathname.slice(1)}_cell_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
const admin = createDatabase({ connectionString: urlFor('postgres'), poolSize: 1 });
const created: string[] = [];

afterAll(async () => {
  for (const name of created)
    await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
  await admin.destroy();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);

interface Cell {
  readonly setting: string;
  /** What a process of this setting acts with. */
  readonly composition: Composition;
  readonly issues: boolean;
  readonly chat: boolean;
}

/**
 * The cells. Where chat does not run, the build is one that carries issues alone: chat's own hooks reach for the tables
 * of its set (`hidden_messages`, `scheduled_messages`, `message_reminders`) whether or not the set was ever applied, which
 * is chat's to decide and not this test's (reported with D-254), and this one is about what issues does.
 */
const CELLS: readonly Cell[] = [
  { setting: 'none', composition: compose([], [issuesModule]), issues: false, chat: false },
  { setting: 'chat', composition: compositionFor('chat'), issues: false, chat: true },
  {
    setting: 'issues',
    composition: compose([issuesModule], [issuesModule]),
    issues: true,
    chat: false,
  },
  { setting: 'all', composition: compositionFor(undefined), issues: true, chat: true },
];

const tablesOf = async (db: Executor): Promise<string[]> =>
  (
    await sql<{ table_name: string }>`
      select table_name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE'`.execute(db)
  ).rows.map((row) => row.table_name);

/** Two people in a workspace of their own, made by the core's tables alone: nothing of any module. */
const seed = async (db: Executor): Promise<{ workspaceId: string; ada: string; bob: string }> => {
  const person = async (name: string): Promise<string> =>
    (
      await db
        .insertInto('users')
        .values({ email: `${name}@example.test`, username: name, display_name: name })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  const ada = await person('ada');
  const bob = await person('bob');
  const { id: workspaceId } = await db
    .insertInto('workspaces')
    .values({ name: 'Cell', slug: 'cell', created_by: ada, deleted_at: NOW, purge_started_at: NOW })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('workspace_members')
    .values([
      { workspace_id: workspaceId, user_id: ada, role: 'owner' },
      { workspace_id: workspaceId, user_id: bob, role: 'member' },
    ])
    .execute();
  return { workspaceId, ada, bob };
};

const cellDatabase = async (cell: Cell, composition: Composition): Promise<Executor> => {
  const name = `${BASE}_${cell.setting}`;
  await sql`create database ${sql.id(name)}`.execute(admin);
  created.push(name);
  await migrateOnStart({ connectionString: urlFor(name) }, undefined, {
    sets: composition.migrationSets,
  });
  return createDatabase({ connectionString: urlFor(name), poolSize: 2 });
};

describe('integration: the core’s lifecycle on a database each cell made', () => {
  for (const cell of CELLS) {
    test(`MODULES=${cell.setting}: ${cell.issues ? 'issues’ table is there and is kept whole' : 'there is no issues table, and nothing of the core reaches for it'}`, async () => {
      const { composition } = cell;
      const db = await cellDatabase(cell, composition);
      try {
        const tables = await tablesOf(db);
        expect(tables.includes('issues')).toBe(cell.issues);
        // Chat's own set (not the core's chat tables, which every cell has).
        expect(tables.includes('scheduled_messages')).toBe(cell.chat);
        expect(tables).toContain('messages');

        expect(
          await readiness(
            db,
            composition.collatedColumns,
            undefined,
            undefined,
            composition.migrationSets,
          ),
        ).toEqual({ ready: true });

        const { workspaceId, ada, bob } = await seed(db);
        const issueId = '0199155c-6200-7b7f-8c11-2a4d3f9e1b70';
        if (cell.issues) {
          await db
            .insertInto('issues')
            .values({
              id: issueId,
              workspace_id: workspaceId,
              title: 'Kept',
              assignee_id: bob,
              created_by: ada,
            })
            .execute();
        }
        const issues = async (): Promise<{ assignee_id: string | null }[]> =>
          await db
            .selectFrom('issues')
            .select('assignee_id')
            .where('workspace_id', '=', workspaceId)
            .execute();

        // An erased account: what the module forgets of it, where the module runs.
        await atomicallyOn(db)(async (transaction) => {
          await composition.userErased.run(transaction, bob);
        });
        if (cell.issues) expect(await issues()).toEqual([{ assignee_id: null }]);

        // A person's export and the workspace's.
        const store = aMemoryStore();
        const log = aRecordingLogger().log;
        const personal = await exportPerson(
          {
            database: db,
            clock,
            log,
            storage: store,
            personalCatalogue: composition.personalExportCatalogue,
          },
          { id: ada, username: 'ada' },
          join(await mkdtemp(join(tmpdir(), 'purlay-cell-')), 'person'),
        );
        expect(Object.keys(personal.manifest.tables).includes('issues')).toBe(cell.issues);
        expect((await readdir(personal.path)).includes('issues.ndjson')).toBe(cell.issues);
        const scope = await composition.exportCatalogue.scopeOf(db, { kind: 'all', workspaceId });
        const exported = await exportWorkspace(
          { database: db, clock, log, storage: store, catalogue: composition.exportCatalogue },
          { id: workspaceId, slug: 'cell', name: 'Cell' },
          scope,
          join(await mkdtemp(join(tmpdir(), 'purlay-cell-')), 'workspace'),
        );
        expect(exported.manifest.tables['issues']).toBe(cell.issues ? 1 : undefined);
        expect((await readdir(exported.path)).includes('issues.ndjson')).toBe(cell.issues);

        // The purge of the workspace.
        await purgeWorkspaceContent(
          { database: db, clock, log, storage: store },
          workspaceId,
          composition.workspacePurge,
        );
        if (cell.issues) expect(await issues()).toEqual([]);
        const purged = await db
          .selectFrom('workspaces')
          .select('purged_at')
          .where('id', '=', workspaceId)
          .executeTakeFirstOrThrow();
        expect(purged.purged_at).not.toBeNull();
      } finally {
        await db.destroy();
      }
    });
  }
});
