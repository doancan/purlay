/**
 * The lifecycle of a person's and a workspace's data in every cell of the module matrix (D-250 rule 5 and 6,
 * `MODULES.md` §5): a database as each valid `MODULES` value leaves it — the core alone, each module's set on the
 * core, every set — each a real database of its own, migrated and dropped, against a process that runs each such
 * value too. The cells are not listed here: `moduleCells` makes them from the modules the build carries, so a module
 * added to the bundle adds its databases and its processes to this file, and the tables its set makes are the ones
 * `TABLE_OWNERS` gives it that the core alone lacks. What a module wrote of its own — chat's messages, issues'
 * issues — is seeded and checked by a probe for that module (`seed`); a module without one is still held to the rest.
 *
 * At three modules or fewer every subset is a cell, databases crossed with processes (2^n × 2^n: 16 at two modules,
 * 64 at three). Past that `subsetsOf` samples: 12 subsets at five modules, so 12 databases and 144 cells, not the
 * 32 databases and 1024 cells of all of them.
 *
 * Chat's own set (`chat/0001`–`0004`) makes five tables, and every bundled module is held whether or not it runs: its
 * erasure, purge and export answers apply to a process that does not run it, because a person's right to be erased does not wait for a
 * setting. So what chat does with those five tables must hold where they are not there (a fresh install with
 * `MODULES=none`) and where they are (an existing install that turned chat off). Every step must succeed and
 * leave the right rows: nothing of the person where a table exists, nothing of the workspace after its purge, an
 * export that holds what is there.
 *
 * A process that runs chat on a database without its set is not a cell: readiness refuses it, and that is asserted.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  closeIntegrationDatabase,
  createDatabase,
  DROP_HOOK_MS,
  dropDatabases,
  migrateToLatest,
  pendingMigrations,
  PRODUCT_MIGRATION_SETS,
  sql,
  TABLE_OWNERS,
  type DatabasePool,
  type Executor,
  type MigrationSet,
  type Transaction,
} from '@purlay/db';
import { WORKSPACE_DELETION_GRACE_DAYS, isErased, messageId } from '@purlay/types';
import { bundledModules, compose, type Composition } from './composition';
import {
  EVERY_TABLE_DECIDED,
  EVERY_TABLE_DECIDED_FOR_PEOPLE,
  EXCLUDED_FROM_EXPORT,
  EXCLUDED_FROM_PERSONAL_EXPORT,
} from './export-catalogue';
import { eraseContent } from './features/chat/messages/content-erasure';
import { purgeRetention } from './features/chat/messages/retention-purge';
import { sendMessage } from './features/chat/messages/messages';
import { sweepObjectDeletions } from './modules/attachments/deletions';
import { discardUpload, storeUpload } from './modules/attachments/uploads';
import { exportWorkspace } from './modules/export/export';
import { exportPerson } from './modules/export/personal';
import { MIGRATOR_TABLES } from './modules/export/tables';
import { sweepGitHubDeliveries, sweepLinkPreviews } from './features/chat/sweeps';
import { sweepOrphans } from './modules/jobs/jobs';
import { sweepExports } from './modules/export/requests';
import { eraseAccount } from './modules/users/erasure';
import { purgeWorkspaces } from './modules/workspaces/deletion-purge';
import { DAY_MS, fixedClock } from './platform/clock';
import { AppError } from './platform/errors';
import { migrateOnStart } from './platform/migrate-on-start';
import { readiness } from './platform/readiness';
import { atomicallyOn } from './platform/transactions';
import { requireWorkspaceMembership } from './platform/tenancy';
import { aRecordingLogger } from './testing/doubles';
import { aRoom, type Room } from './testing/rooms';
import { aSession } from './testing/signed-in';
import { linkFile } from './testing/sent-files';
import { aMemoryStore, type MemoryStore } from './testing/storage';
import { moduleCells } from './testing/module-cells';
import { aUniqueSlug, aUserRow } from './testing/users';

/** Every table chat keeps of a person, by the column that names them. */
const CHAT_PERSONAL_TABLES = [
  'hidden_messages',
  'message_reminders',
  'scheduled_messages',
  'saved_messages',
  'saved_searches',
  'thread_follows',
  'notifications',
  'missed_mail_letters',
] as const;

interface DatabaseState {
  readonly name: string;
  readonly sets: readonly MigrationSet[];
}

/** Whether a module's own set has been applied to the database: whether its tables are there. */
const hasSet = (state: DatabaseState, id: string): boolean =>
  state.sets.some((set) => set.id === id);

const CELLS = moduleCells(bundledModules);

/** A database as each cell's `MODULES` value migrates it. */
const DATABASE_STATES: readonly DatabaseState[] = CELLS.map((cell) => ({
  name: cell.setting === undefined ? 'legacy-shaped, every set applied' : `fresh, ${cell.label}`,
  sets: cell.composition.migrationSets,
}));

const CORE_ALONE = DATABASE_STATES[0]!;

interface Run {
  readonly name: string;
  readonly composition: Composition;
  /** The modules it runs, whose sets its database must have where they keep one: readiness refuses it otherwise. */
  readonly runs: readonly string[];
}

/** Every process the matrix promises: one for each cell, the core alone and the modules in each combination. */
const RUNS: readonly Run[] = CELLS.map((cell) => ({
  name: `${cell.label} run`,
  composition: cell.composition,
  runs: cell.ids,
}));

const urlOf = (name: string): string => {
  const url = new URL(process.env['DATABASE_URL'] ?? '');
  url.pathname = `/${name}`;
  return url.toString();
};

const administration = (): DatabasePool =>
  createDatabase({ connectionString: urlOf('postgres'), poolSize: 1 });

const created: string[] = [];

/** A database of its own, named for this run and dropped after it; never the shared one. */
const freshDatabase = async (sets: readonly MigrationSet[]): Promise<string> => {
  const name = `lifecycle_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const admin = administration();
  try {
    await sql`create database ${sql.id(name)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  created.push(name);
  const migrating = createDatabase({ connectionString: urlOf(name), poolSize: 1 });
  try {
    const { error } = await migrateToLatest(migrating, undefined, { modules: sets });
    expect(error).toBeUndefined();
  } finally {
    await migrating.destroy();
  }
  return name;
};

afterAll(async () => {
  await dropDatabases(created);
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

/** Later than anything the database wrote with its own clock, so that a job's cutoffs are all in the past. */
const NOW = new Date(Date.now() + 2 * DAY_MS);
const clock = fixedClock(NOW);
const log = aRecordingLogger().log;

let tick = 0;
const anId = (at: Date = NOW): string => messageId(new Date(at.getTime() + (tick += 1)));

interface Person {
  readonly userId: string;
  readonly username: string;
}

interface World {
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly ada: Person;
  readonly bob: Person;
  readonly sessionId: string;
  /** Chat's: undefined where chat's tables are not there, and none can have been written. */
  readonly chat?: {
    readonly room: Room;
    readonly recent: string;
    readonly old: string;
    readonly bobs: string;
    readonly recentFile: string;
    readonly oldFile: string;
  };
  /** Issues': undefined where its table is not there. `bobsOnAda` is bob's issue given to ada, `adas` ada's given to bob. */
  readonly issues?: { readonly bobsOnAda: string; readonly adas: string };
  /** An upload nobody sent. */
  readonly unsentFile: string;
  readonly store: MemoryStore;
}

const person = (room: Room, name: string): Room['members'][string] => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

const upload = async (
  tx: Transaction,
  store: MemoryStore,
  workspaceId: string,
  userId: string,
): Promise<string> => {
  const id = anId();
  await storeUpload(
    { atomically: atomicallyOn(tx), storage: store, log },
    await requireWorkspaceMembership(tx, userId, workspaceId),
    { id, name: 'plan.pdf', bytes: new Uint8Array(10).fill(7) },
  );
  return id;
};

/**
 * A workspace with two people and what the core keeps of them; where chat's tables are there, also what chat
 * keeps: messages, files sent with them, and each person's own reminders, drafts and hidden messages. Where they
 * are not, no message can have been written — chat never ran — so none is.
 */
const seed = async (database: DatabasePool, state: DatabaseState): Promise<World> =>
  await database.transaction().execute(async (tx) => {
    const store = aMemoryStore();
    let workspaceId: string;
    let ada: Person;
    let bob: Person;
    let room: Room | undefined;
    if (hasSet(state, 'chat')) {
      room = await aRoom(tx, ['bob', 'ada']);
      workspaceId = room.workspaceId;
      ada = person(room, 'ada');
      bob = person(room, 'bob');
    } else {
      ada = await aUserRow(tx, 'ada');
      bob = await aUserRow(tx, 'bob');
      workspaceId = (
        await tx
          .insertInto('workspaces')
          .values({ name: 'Core', slug: aUniqueSlug('core') })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await tx
        .insertInto('workspace_members')
        .values([
          { workspace_id: workspaceId, user_id: bob.userId, role: 'owner' },
          { workspace_id: workspaceId, user_id: ada.userId, role: 'member' },
        ])
        .execute();
    }
    const workspaceSlug = (
      await tx
        .selectFrom('workspaces')
        .select('slug')
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow()
    ).slug;
    const { sessionId } = await aSession(tx, clock, ada.userId);
    // What the core keeps of a person, whatever runs.
    await tx
      .insertInto('saved_searches')
      .values({
        id: anId(),
        name: 'mine',
        query: JSON.stringify({ q: 'x' }),
        user_id: ada.userId,
        workspace_id: workspaceId,
      })
      .execute();
    await tx
      .insertInto('missed_mail_letters')
      .values({ sent_at: NOW, stop_digest: crypto.randomUUID(), user_id: ada.userId })
      .execute();
    const unsentFile = await upload(tx, store, workspaceId, ada.userId);
    // What issues keeps, where its table is there: an issue each made and gave to the other.
    let issues: World['issues'];
    if (hasSet(state, 'issues')) {
      const make = async (by: Person, to: Person, title: string): Promise<string> =>
        (
          await tx
            .insertInto('issues')
            .values({
              id: anId(),
              workspace_id: workspaceId,
              title,
              body: 'details',
              created_by: by.userId,
              assignee_id: to.userId,
            })
            .returning('id')
            .executeTakeFirstOrThrow()
        ).id;
      issues = {
        bobsOnAda: await make(bob, ada, 'bob made, ada has it'),
        adas: await make(ada, bob, 'ada made, bob has it'),
      };
    }

    if (room === undefined) {
      return {
        workspaceId,
        workspaceSlug,
        ada,
        bob,
        sessionId,
        unsentFile,
        store,
        ...(issues === undefined ? {} : { issues }),
      };
    }
    const channel = room.channelId;
    const say = async (who: 'ada' | 'bob', at: Date, content: string): Promise<string> => {
      const sent = await sendMessage(tx, fixedClock(at), person(room, who).context, {
        id: anId(at),
        content,
      });
      return sent.message.id;
    };
    const recent = await say('ada', new Date(NOW.getTime() - 1000), 'hello');
    const old = await say('ada', new Date(NOW.getTime() - 40 * DAY_MS), 'long ago');
    const bobs = await say('bob', new Date(NOW.getTime() - 2000), 'hi');
    const recentFile = await upload(tx, store, workspaceId, ada.userId);
    await linkFile(tx, { id: recentFile, workspaceId, messageId: recent, channelId: channel });
    const oldFile = await upload(tx, store, workspaceId, ada.userId);
    await linkFile(tx, { id: oldFile, workspaceId, messageId: old, channelId: channel });
    // What chat keeps of each of them, ada's and bob's (the control), in the tables that exist everywhere ...
    for (const who of [ada, bob]) {
      await tx
        .insertInto('saved_messages')
        .values({
          id: anId(),
          user_id: who.userId,
          workspace_id: workspaceId,
          channel_id: channel,
          message_id: bobs,
        })
        .execute();
      await tx
        .insertInto('thread_follows')
        .values({
          user_id: who.userId,
          workspace_id: workspaceId,
          channel_id: channel,
          message_id: bobs,
          following: true,
        })
        .execute();
      await tx
        .insertInto('notifications')
        .values({
          user_id: who.userId,
          workspace_id: workspaceId,
          channel_id: channel,
          message_id: bobs,
          type: 'mention',
        })
        .execute();
      // ... and in the five that chat's own set makes.
      await tx
        .insertInto('hidden_messages')
        .values({
          user_id: who.userId,
          message_id: bobs,
          channel_id: channel,
          workspace_id: workspaceId,
        })
        .execute();
      await tx
        .insertInto('message_reminders')
        .values({
          user_id: who.userId,
          workspace_id: workspaceId,
          channel_id: channel,
          message_id: bobs,
          remind_at: new Date(NOW.getTime() + DAY_MS),
        })
        .execute();
      await tx
        .insertInto('scheduled_messages')
        .values({
          id: anId(),
          user_id: who.userId,
          workspace_id: workspaceId,
          channel_id: channel,
          content: 'later',
          send_at: new Date(NOW.getTime() + DAY_MS),
        })
        .execute();
    }
    return {
      workspaceId,
      workspaceSlug,
      ada,
      bob,
      sessionId,
      unsentFile,
      store,
      chat: { room, recent, old, bobs, recentFile, oldFile },
      ...(issues === undefined ? {} : { issues }),
    };
  });

const presentTables = async (database: Executor): Promise<string[]> =>
  (
    await sql<{ name: string }>`
      select table_name as name from information_schema.tables
      where table_schema = current_schema() and table_type = 'BASE TABLE' order by 1`.execute(
      database,
    )
  ).rows.map((row) => row.name);

/** One database per state, made once however many tests ask: the core alone is asked by every state. */
interface BuiltDatabase {
  readonly name: string;
  readonly present: string[];
}

const built = new Map<DatabaseState, Promise<BuiltDatabase>>();

const databaseOf = async (state: DatabaseState): Promise<BuiltDatabase> => {
  let pending = built.get(state);
  if (pending === undefined) {
    pending = (async (): Promise<BuiltDatabase> => {
      const name = await freshDatabase(state.sets);
      const reading = createDatabase({ connectionString: urlOf(name), poolSize: 1 });
      try {
        return { name, present: await presentTables(reading) };
      } finally {
        await reading.destroy();
      }
    })();
    built.set(state, pending);
  }
  return await pending;
};

/** The tables a module's own set makes: the ones `TABLE_OWNERS` gives it that the core alone does not have. */
const ownTables = (id: string, coreTables: readonly string[]): string[] =>
  Object.entries(TABLE_OWNERS)
    .filter(([table, owner]) => owner === id && !coreTables.includes(table))
    .map(([table]) => table);

const countWhere = async (
  database: Executor,
  table: string,
  column: string,
  value: string,
): Promise<number> =>
  Number(
    (
      await sql<{ count: string }>`
        select count(*)::text as count from ${sql.table(table)} where ${sql.id(column)} = ${value}`.execute(
        database,
      )
    ).rows[0]?.count,
  );

/** How many rows of each table in the database name the workspace, the trails left out. */
const footprint = async (
  database: Executor,
  workspaceId: string,
): Promise<Record<string, number>> => {
  const { rows } = await sql<{ table: string }>`
    select table_name as table from information_schema.columns
    where table_schema = current_schema() and column_name = 'workspace_id'
      and table_name not in ('audit_log', 'server_audit_log')
    order by 1`.execute(database);
  const counts: Record<string, number> = {};
  for (const { table } of rows) {
    counts[table] = await countWhere(database, table, 'workspace_id', workspaceId);
  }
  return counts;
};

const total = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);

const exportTarget = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), 'purlay-lifecycle-')), 'out');

describe('integration: the data lifecycle in every cell of the module matrix', () => {
  for (const state of DATABASE_STATES) {
    describe(`database ${state.name}`, () => {
      let database: DatabasePool;
      let present: readonly string[];
      let coreTables: readonly string[];

      beforeAll(async () => {
        const built = await databaseOf(state);
        database = createDatabase({ connectionString: urlOf(built.name), poolSize: 4 });
        present = built.present;
        coreTables = (await databaseOf(CORE_ALONE)).present;
      }, CLONE_HOOK_MS);
      afterAll(async () => {
        await database.destroy();
      }, DROP_HOOK_MS);

      test('each set’s tables are there exactly where its set was applied', () => {
        for (const set of PRODUCT_MIGRATION_SETS) {
          expect(ownTables(set.id, coreTables).length).toBeGreaterThan(0);
        }
        for (const { manifest } of bundledModules) {
          for (const table of ownTables(manifest.id, coreTables)) {
            expect(`${table}: ${String(present.includes(table))}`).toBe(
              `${table}: ${String(hasSet(state, manifest.id))}`,
            );
          }
        }
      });

      for (const run of RUNS) {
        const lacking = run.composition.migrationSets
          .map((set) => set.id)
          .filter((id) => !hasSet(state, id));
        if (lacking.length > 0) {
          test(`${run.name}: readiness refuses a process that runs ${lacking.join(' and ')} without its set`, async () => {
            const pending = await pendingMigrations(
              database,
              undefined,
              run.composition.migrationSets,
            );
            expect(pending.length).toBeGreaterThan(0);
            expect(
              pending.every((migration) => lacking.some((id) => migration.startsWith(`${id}/`))),
            ).toBe(true);
            const verdict = await readiness(
              database,
              run.composition.collatedColumns,
              undefined,
              undefined,
              run.composition.migrationSets,
            );
            expect(verdict.ready).toBe(false);
          });
          continue;
        }

        describe(run.name, () => {
          const { composition: processes } = run;

          test('(f) readiness: ready', async () => {
            const verdict = await readiness(
              database,
              processes.collatedColumns,
              undefined,
              undefined,
              processes.migrationSets,
            );
            expect(verdict).toEqual({ ready: true });
          });

          test('(a) erasing an account forgets what chat and issues hold of the person, and keeps the team’s', async () => {
            const world = await seed(database, state);
            const erased = await database
              .transaction()
              .execute(
                async (tx) =>
                  await eraseAccount(
                    tx,
                    clock,
                    { userId: world.ada.userId, sessionId: world.sessionId },
                    world.ada.username,
                    processes.userErased,
                  ),
              );
            expect(erased.userId).toBe(world.ada.userId);
            const row = await database
              .selectFrom('users')
              .select('username')
              .where('id', '=', world.ada.userId)
              .executeTakeFirstOrThrow();
            expect(isErased(row)).toBe(true);
            expect(await countWhere(database, 'sessions', 'user_id', world.ada.userId)).toBe(0);
            for (const table of CHAT_PERSONAL_TABLES) {
              if (!present.includes(table)) continue;
              expect(
                `${table}: ${String(await countWhere(database, table, 'user_id', world.ada.userId))}`,
              ).toBe(`${table}: 0`);
            }
            if (world.issues !== undefined) {
              // Taken off what was given to them; what they made stays, under the anonymised row; bob's is bob's.
              const issue = async (
                id: string,
              ): Promise<{ assignee_id: string | null; created_by: string | null }> =>
                await database
                  .selectFrom('issues')
                  .select(['assignee_id', 'created_by'])
                  .where('id', '=', id)
                  .executeTakeFirstOrThrow();
              expect(await issue(world.issues.bobsOnAda)).toEqual({
                assignee_id: null,
                created_by: world.bob.userId,
              });
              expect(await issue(world.issues.adas)).toEqual({
                assignee_id: world.bob.userId,
                created_by: world.ada.userId,
              });
            }
            if (world.chat !== undefined) {
              // The team keeps its words under the anonymised row, and bob keeps what is bob's.
              expect(await countWhere(database, 'messages', 'sender_id', world.ada.userId)).toBe(2);
              for (const table of CHAT_PERSONAL_TABLES) {
                if (!present.includes(table) || table === 'saved_searches') continue;
                if (table === 'missed_mail_letters') continue;
                expect(
                  `${table}: ${String((await countWhere(database, table, 'user_id', world.bob.userId)) > 0)}`,
                ).toBe(`${table}: true`);
              }
            }
          });

          test('(b) a deleted workspace, once its grace is over, is purged to nothing, beside a control untouched', async () => {
            const doomed = await seed(database, state);
            const control = await seed(database, state);
            const before = await footprint(database, doomed.workspaceId);
            expect(total(before)).toBeGreaterThan(0);
            const controlBefore = await footprint(database, control.workspaceId);
            await database
              .updateTable('workspaces')
              .set({
                deleted_at: new Date(NOW.getTime() - (WORKSPACE_DELETION_GRACE_DAYS + 1) * DAY_MS),
              })
              .where('id', '=', doomed.workspaceId)
              .execute();
            const done = await purgeWorkspaces(
              { database, clock, log, storage: doomed.store },
              processes.workspacePurge,
            );
            expect(done.workspaces).toBeGreaterThanOrEqual(1);
            const tombstone = await database
              .selectFrom('workspaces')
              .select('purged_at')
              .where('id', '=', doomed.workspaceId)
              .executeTakeFirstOrThrow();
            expect(tombstone.purged_at).not.toBeNull();
            const left = await footprint(database, doomed.workspaceId);
            expect(Object.entries(left).filter(([, count]) => count > 0)).toEqual([]);
            expect(doomed.store.keys()).toEqual([]);
            expect(await footprint(database, control.workspaceId)).toEqual(controlBefore);
          });

          test('(c) the workspace’s export and a person’s hold what is there, and every table is decided', async () => {
            const world = await seed(database, state);
            expect(EVERY_TABLE_DECIDED).toBe(true);
            expect(EVERY_TABLE_DECIDED_FOR_PEOPLE).toBe(true);
            const catalogue = processes.exportCatalogue;
            const personal = processes.personalExportCatalogue;
            // What the database holds is what the catalogues decided, less the tables its set did not make.
            const held = present.filter((table) => !MIGRATOR_TABLES.includes(table)).sort();
            const missing = bundledModules
              .filter(({ manifest }) => !hasSet(state, manifest.id))
              .flatMap(({ manifest }) => ownTables(manifest.id, coreTables));
            const expected = (decided: readonly string[]): string[] =>
              decided.filter((table) => !missing.includes(table)).sort();
            expect(held).toEqual(
              expected([...catalogue.order, ...Object.keys(EXCLUDED_FROM_EXPORT)]),
            );
            expect(held).toEqual(
              expected([...personal.order, ...Object.keys(EXCLUDED_FROM_PERSONAL_EXPORT)]),
            );

            const scope = await catalogue.scopeOf(database, {
              kind: 'all',
              workspaceId: world.workspaceId,
            });
            const workspaceExport = await exportWorkspace(
              { database, clock, log, storage: world.store, catalogue },
              { id: world.workspaceId, slug: world.workspaceSlug, name: 'Export' },
              scope,
              await exportTarget(),
            );
            expect(workspaceExport.manifest.tables['workspaces']).toBe(1);
            expect(workspaceExport.manifest.tables['workspace_members']).toBe(2);
            expect(workspaceExport.manifest.tables['messages']).toBe(
              world.chat === undefined ? 0 : 3,
            );
            // A file leaves with the message it was sent with; one nobody sent does not.
            expect(workspaceExport.manifest.tables['attachments']).toBe(
              world.chat === undefined ? 0 : 2,
            );
            expect(workspaceExport.manifest.blobs.count).toBe(world.chat === undefined ? 0 : 2);
            // Issues' rows leave with the workspace where its table is there, whatever the process runs; where not, none.
            expect(workspaceExport.manifest.tables['issues']).toBe(
              world.issues === undefined ? 0 : 2,
            );

            const personExport = await exportPerson(
              { database, clock, log, storage: world.store, personalCatalogue: personal },
              { id: world.ada.userId, username: world.ada.username },
              await exportTarget(),
            );
            expect(personExport.manifest.tables['users']).toBe(1);
            expect(personExport.manifest.tables['messages']).toBe(world.chat === undefined ? 0 : 2);
            expect(personExport.manifest.tables['attachments']).toBe(
              world.chat === undefined ? 0 : 2,
            );
            expect(personExport.manifest.blobs.count).toBe(world.chat === undefined ? 0 : 2);
            // Only the issues the person made.
            expect(personExport.manifest.tables['issues']).toBe(world.issues === undefined ? 0 : 1);
          });

          test('(d) the retention purge and the sweeps that run with chat off leave the right rows', async () => {
            const world = await seed(database, state);
            await database
              .updateTable('workspaces')
              .set({ retention_days: 30 })
              .where('id', '=', world.workspaceId)
              .execute();
            await database
              .insertInto('link_previews')
              .values({
                url: `https://example.test/${crypto.randomUUID()}`,
                url_hash: crypto.randomUUID(),
                payload: JSON.stringify({}),
                expires_at: new Date(NOW.getTime() - DAY_MS),
              })
              .execute();
            await database
              .insertInto('github_app_deliveries')
              .values({
                delivery_id: crypto.randomUUID(),
                body_digest: 'ab'.repeat(32),
                received_at: new Date(NOW.getTime() - 60 * DAY_MS),
              })
              .execute();
            await database
              .insertInto('workspace_exports')
              .values({
                id: anId(),
                workspace_id: world.workspaceId,
                status: 'ready',
                storage_key: `exports/${crypto.randomUUID()}`,
                size_bytes: '1',
                created_at: new Date(NOW.getTime() - 3 * DAY_MS),
                expires_at: new Date(NOW.getTime() - DAY_MS),
              })
              .execute();

            const purged = await purgeRetention({ database, clock, log, storage: world.store });
            expect(purged.workspaces).toBeGreaterThanOrEqual(1);
            if (world.chat !== undefined) {
              const alive = (
                await database
                  .selectFrom('messages')
                  .select('id')
                  .where('workspace_id', '=', world.workspaceId)
                  .execute()
              ).map((row) => row.id);
              expect(alive.sort()).toEqual([world.chat.recent, world.chat.bobs].sort());
              // The file of the message past the window went with it; the one of the message kept stays.
              const files = (
                await database
                  .selectFrom('attachments')
                  .select('id')
                  .where('workspace_id', '=', world.workspaceId)
                  .execute()
              ).map((row) => row.id);
              expect(files).not.toContain(world.chat.oldFile);
              expect(files).toContain(world.chat.recentFile);
            }

            const orphans = await sweepOrphans({ database, clock, log, storage: world.store });
            expect(orphans.removed).toBeGreaterThanOrEqual(1);
            expect(orphans.leftBehind).toBe(0);
            expect(await countWhere(database, 'attachments', 'id', world.unsentFile)).toBe(0);
            expect((await sweepLinkPreviews({ database, clock })).removed).toBeGreaterThanOrEqual(
              1,
            );
            expect(
              (await sweepGitHubDeliveries({ database, clock })).removed,
            ).toBeGreaterThanOrEqual(1);
            const exports = await sweepExports({ database, clock, log, storage: world.store });
            expect(exports.expired).toBeGreaterThanOrEqual(1);
            await sweepObjectDeletions({
              database,
              atomically: atomicallyOn(database),
              log,
              storage: world.store,
            });
            expect(
              await database
                .selectFrom('object_deletions')
                .select('storage_key')
                .where('storage_key', 'like', `%${world.workspaceId}%`)
                .execute(),
            ).toEqual([]);
          });

          test('(d) the operator’s content erasure empties what the person wrote where chat’s tables are, and nothing where not', async () => {
            const world = await seed(database, state);
            const [done] = await eraseContent(
              { database, clock, log, storage: world.store },
              world.ada.userId,
              [world.workspaceId],
            );
            expect(done?.leftBehind).toBe(0);
            expect(done?.messages).toBe(world.chat === undefined ? 0 : 2);
            expect(done?.files).toBe(world.chat === undefined ? 0 : 2);
            if (world.chat !== undefined) {
              const wrote = await database
                .selectFrom('messages')
                .select('deleted_at')
                .where('sender_id', '=', world.ada.userId)
                .execute();
              expect(wrote.every((row) => row.deleted_at !== null)).toBe(true);
              expect(
                await countWhere(database, 'message_attachments', 'message_id', world.chat.recent),
              ).toBe(0);
            }
          });

          test('(e) the process’s attachment reader (chat’s, or the core’s own) reads a file whether or not the link table is there', async () => {
            const world = await seed(database, state);
            // An upload nobody sent is its uploader's, and no one else’s.
            const mine = await processes.readAttachment(
              database,
              world.ada.userId,
              world.unsentFile,
            );
            expect(mine.id).toBe(world.unsentFile);
            const refusal = await processes
              .readAttachment(database, world.bob.userId, world.unsentFile)
              .then(
                () => 'taken',
                (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
              );
            expect(refusal).toBe('ATTACHMENT_NOT_FOUND');
            if (world.chat !== undefined && run.runs.includes('chat')) {
              // Only chat knows what was sent with a message: one sent is anyone's who can see the channel.
              const theirs = await processes.readAttachment(
                database,
                world.bob.userId,
                world.chat.recentFile,
              );
              expect(theirs.id).toBe(world.chat.recentFile);
            }
            await discardUpload(
              { atomically: atomicallyOn(database), storage: world.store, log },
              world.ada.userId,
              world.unsentFile,
            );
            expect(await countWhere(database, 'attachments', 'id', world.unsentFile)).toBe(0);
          });
        });
      }
    });
  }

  describe('a node that migrates as it starts', () => {
    // Each module that keeps a set, run alone: the cells that name one module and make one set.
    const alone = CELLS.filter(
      (cell) => cell.ids.length === 1 && cell.composition.migrationSets.length === 1,
    );
    for (const cell of alone) {
      const [id] = cell.ids as [string];
      test(
        `(f) the core alone first, ${id}’s set when ${id} is turned on, and either way ready`,
        async () => {
          const name = await freshDatabase([]);
          const database = createDatabase({ connectionString: urlOf(name), poolSize: 2 });
          try {
            const none = compose([]);
            const first = await migrateOnStart({ connectionString: urlOf(name) }, undefined, {
              sets: none.migrationSets,
            });
            expect(first).toEqual([]);
            expect(
              (
                await readiness(
                  database,
                  none.collatedColumns,
                  undefined,
                  undefined,
                  none.migrationSets,
                )
              ).ready,
            ).toBe(true);
            // The module turned on later opens on the set it never had, and applies it, and not before.
            const only = cell.composition;
            expect(
              (
                await readiness(
                  database,
                  only.collatedColumns,
                  undefined,
                  undefined,
                  only.migrationSets,
                )
              ).ready,
            ).toBe(false);
            const second = await migrateOnStart({ connectionString: urlOf(name) }, undefined, {
              sets: only.migrationSets,
            });
            expect(second.length).toBeGreaterThan(0);
            expect(second.every((migration) => migration.startsWith(`${id}/`))).toBe(true);
            // Every other set was never applied here, so only the processes that run none of them are ready.
            for (const run of RUNS.filter((each) =>
              each.composition.migrationSets.every((set) => set.id === id),
            )) {
              expect(
                (
                  await readiness(
                    database,
                    run.composition.collatedColumns,
                    undefined,
                    undefined,
                    run.composition.migrationSets,
                  )
                ).ready,
              ).toBe(true);
            }
            const tables = await presentTables(database);
            const coreTables = (await databaseOf(CORE_ALONE)).present;
            for (const table of ownTables(id, coreTables)) expect(tables).toContain(table);
          } finally {
            await database.destroy();
          }
        },
        CLONE_HOOK_MS,
      );
    }
  });
});
