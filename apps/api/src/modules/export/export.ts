/**
 * A workspace's export (D-27 §3, D-140): one NDJSON file per table of `tables.ts`, each row as the
 * database writes it, and a manifest last.
 *
 * - **One snapshot.** Every table is read in one `REPEATABLE READ READ ONLY` transaction, so a message
 *   sent while the export runs is in every file or in none — a reaction never names a message the
 *   export lacks. The transaction holds nothing but rows to read: the files the export names are
 *   copied after it commits, so a slow store cannot hold it open past the pool's idle limit.
 * - **Rows the database writes.** `row_to_json` in SQL, so a time keeps its microseconds, a JSON column
 *   stays JSON and a big number stays exact — nothing is parsed and printed again in between.
 * - **Flat memory.** A server-side cursor per table, fetched a page at a time and written as it comes:
 *   however large the workspace, one page is held.
 * - **Bounded to the workspace**, and to the channels the export covers, by each table's own key or its
 *   parent's (`BOUNDS`) — the substitute for a request's `WorkspaceContext`, which a command has none of.
 *   People are those the exported rows name (`PEOPLE`).
 */
import type { Database, Executor, Transaction } from '@purlay/db';
import { EXPORT_FORMAT, type ExportManifest } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import { atomicallyOn, snapshotOn } from '../../platform/transactions';
import { recordAudit } from '../audit/audit';
import { exportDirectory, type ExportDirectory } from './write';
import { workspacePrefix, type ObjectStore } from '../../platform/storage';
import { sql, type RawBuilder } from '@purlay/db';
import type { Catalogue, Scope, TableExport } from './catalogue';

/** Rows one fetch of a cursor holds. */
const PAGE = 1_000;

/** The columns of a table as the export writes them; a member-only column is empty for the rest. */
const projection = (table: TableExport, scope: Scope): RawBuilder<unknown> => {
  const parts = Object.entries(table.columns).flatMap(([column, kind]) => {
    const name = sql.ref(column);
    if (kind === 'omit') return [];
    if (kind === 'export') return [name];
    // An address only ever reaches its owner in the product (`models.ts`): an owner's export has none;
    // the operator's, the controller's own records, has the current members' (D-140 §3).
    if (kind === 'operator' && scope.kind !== 'all') return [sql`null as ${name}`];
    return [
      sql`case when id in (select user_id from workspace_members where workspace_id = ${scope.workspaceId}) then ${name} end as ${name}`,
    ];
  });
  return sql.join(parts);
};

/** The shape every row was in; a database the migrator never ran on has none, and is refused. */
const latestMigration = (name: string | undefined): string => {
  if (name === undefined)
    throw new Error('the database has no migrations: there is nothing to export');
  return name;
};

/** Takes each line a table's rows make, a page at a time. */
export type LineSink = (table: keyof Database, lines: readonly string[]) => Promise<void>;

/**
 * One table's rows, as the database writes each, through a cursor a page at a time: what both a
 * workspace's export and a person's (D-241) read with. Answers how many rows there were.
 */
export const readTable = async (
  transaction: Transaction,
  table: keyof Database,
  read: {
    readonly columns: RawBuilder<unknown>;
    readonly where: RawBuilder<unknown>;
    readonly order: string;
  },
  sink: LineSink,
): Promise<number> => {
  const cursor = `export_${table}`;
  await sql`declare ${sql.raw(cursor)} no scroll cursor for
    select row_to_json(t)::text as line from (
      select ${read.columns} from ${sql.table(table)} where ${read.where} order by ${sql.raw(read.order)}
    ) t`.execute(transaction);
  let rows = 0;
  for (;;) {
    const page = await sql<{
      line: string;
    }>`fetch ${sql.raw(String(PAGE))} from ${sql.raw(cursor)}`.execute(transaction);
    if (page.rows.length === 0) break;
    rows += page.rows.length;
    await sink(
      table,
      page.rows.map((row) => row.line),
    );
    if (page.rows.length < PAGE) break;
  }
  await sql`close ${sql.raw(cursor)}`.execute(transaction);
  return rows;
};

/** Reads every table of the scope inside the transaction it is given, handing the lines on. */
export const readTables = async (
  transaction: Transaction,
  scope: Scope,
  sink: LineSink,
  catalogue: Catalogue,
): Promise<Readonly<Record<string, number>>> => {
  const counted: Record<string, number> = {};
  const people = catalogue.people(scope);
  for (const name of catalogue.order) {
    const table = catalogue.table(name);
    if (scope.absent?.includes(name) === true) {
      counted[name] = 0;
      continue;
    }
    counted[name] = await readTable(
      transaction,
      name,
      { columns: projection(table, scope), ...table.bounds(scope, people) },
      sink,
    );
  }
  return counted;
};

/**
 * The shape every row was in, read inside the snapshot: the last migration the database had. A module's
 * migrations are recorded as `<module>/<file>` and sort among the core's, so they are left out — the stamp
 * names the core's shape, and a module that is off must not change it (D-250).
 */
export const schemaOf = async (transaction: Transaction): Promise<string> => {
  const latest = await sql<{ name: string }>`
    select name from kysely_migration where name not like '%/%' order by name desc limit 1
  `.execute(transaction);
  return latestMigration(latest.rows[0]?.name);
};

/**
 * A file the export names: whose workspace it is, where the store keeps it, and how many bytes the row
 * says it has.
 */
export interface StoredFile {
  readonly id: string;
  readonly workspace_id: string;
  readonly storage_key: string;
  readonly thumbnail_key: string | null;
  readonly size_bytes: string;
}

/** The files of the attachments `where` selects, read inside the snapshot. */
export const filesOf = async (
  transaction: Transaction,
  where: RawBuilder<unknown> | undefined,
): Promise<StoredFile[]> =>
  where === undefined
    ? []
    : (
        await sql<StoredFile>`
      select id, workspace_id, storage_key, thumbnail_key, size_bytes::text as size_bytes
      from attachments where ${where} order by id
    `.execute(transaction)
      ).rows;

/**
 * Copies each file the snapshot named, after it committed. A file the store does not have is either
 * gone since the snapshot — its row is gone too: removed, said and not a fault — or missing while its
 * row is still there, which is a fault the manifest names and the operator is told of. A store that
 * refuses to answer is not absence (`storage.ts`): the export stops. A file whose bytes are not the
 * row's stops it too: a copy that might be partial is no copy.
 */
export const copyObjects = async (
  database: Executor,
  storage: ObjectStore,
  objects: readonly StoredFile[],
  directory: ExportDirectory,
): Promise<ExportManifest['blobs']> => {
  const blobs = { count: 0, bytes: 0, removed: [] as string[], missing: [] as string[] };
  for (const file of objects) {
    // Defence in depth: a key of the row's own workspace or none (`workspacePrefix` names them so).
    for (const key of [file.storage_key, file.thumbnail_key]) {
      if (key !== null && !key.startsWith(workspacePrefix(file.workspace_id))) {
        throw new Error(`attachment ${file.id} names a file outside its workspace`);
      }
    }
    const original = await storage.get(file.storage_key);
    if (original === null) {
      const still = await database
        .selectFrom('attachments')
        .select('id')
        .where('id', '=', file.id)
        .executeTakeFirst();
      (still === undefined ? blobs.removed : blobs.missing).push(file.id);
      continue;
    }
    const written = await directory.writeBlob(file.id, original.body);
    if (written !== Number(file.size_bytes)) {
      throw new Error(
        `attachment ${file.id} has ${String(written)} bytes in the store, not the ${file.size_bytes} its row says`,
      );
    }
    blobs.count += 1;
    blobs.bytes += written;
    if (file.thumbnail_key !== null) {
      // A thumbnail is drawn from the original, and a lost one is drawn again: not a fault.
      const thumbnail = await storage.get(file.thumbnail_key);
      if (thumbnail !== null) {
        blobs.bytes += await directory.writeBlob(`${file.id}.thumbnail`, thumbnail.body);
      }
    }
  }
  return blobs;
};

/**
 * Exports the workspace into `target` (D-140): the tables in one snapshot, the files written as they
 * come, the manifest last, and one line on the workspace's trail once the export exists.
 */
export const exportWorkspace = async (
  dependencies: {
    readonly database: Executor;
    readonly clock: Clock;
    readonly log: Logger;
    readonly storage: ObjectStore;
    /** What the export holds, assembled from the core's contribution and the modules' (D-250). */
    readonly catalogue: Catalogue;
  },
  workspace: { readonly id: string; readonly slug: string; readonly name: string },
  scope: Scope,
  target: string,
  /**
   * The trail's line: written here, by nobody in the workspace (the operator's export), or left to the
   * caller, who writes it once the export has reached whoever asked (an owner's, `requests.ts`).
   */
  trail: 'here' | 'caller' = 'here',
): Promise<{ readonly path: string; readonly manifest: ExportManifest }> => {
  const { database, clock, log, storage, catalogue } = dependencies;
  const directory = await exportDirectory(target);
  try {
    const { tables, schema, objects } = await snapshotOn(database)(async (transaction) => ({
      schema: await schemaOf(transaction),
      tables: await readTables(transaction, scope, directory.write, catalogue),
      objects: await filesOf(transaction, catalogue.files(scope)),
    }));
    // The snapshot has committed: the files are copied outside it, however slow the store.
    const blobs = await copyObjects(database, storage, objects, directory);
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      exportedAt: clock.now().toISOString(),
      workspace,
      schema,
      scope: scope.kind,
      tables,
      blobs,
    };
    await directory.seal(manifest, catalogue.order);
    // On the trail before it takes its name: an export nobody can find a line for must not exist.
    if (trail === 'here')
      await atomicallyOn(database)(async (transaction) => {
        await recordAudit(transaction, clock, {
          workspaceId: workspace.id,
          actorUserId: null,
          action: 'workspace.exported',
          targetType: 'workspace',
          targetId: workspace.id,
          metadata: { scope: scope.kind, ...catalogue.audit(tables) },
        });
      });
    const path = await directory.publish();
    log.info('workspace exported', {
      workspaceId: workspace.id,
      rows: tables,
      files: blobs.count,
      missing: blobs.missing.length,
    });
    return { path, manifest };
  } catch (error) {
    await directory.abandon();
    throw error;
  }
};
