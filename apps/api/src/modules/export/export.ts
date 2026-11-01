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
import { COLUMNS, type ExportedTable } from './tables';

/** Rows one fetch of a cursor holds. */
const PAGE = 1_000;

/** In the order a reader re-importing them would want: parents before their children. */
export const TABLE_ORDER: readonly ExportedTable[] = [
  'workspaces',
  'users',
  'workspace_members',
  'channels',
  'channel_members',
  'messages',
  'reactions',
  'mentions',
  'message_versions',
  'pinned_messages',
  'channel_bookmarks',
  'attachments',
  'incidents',
  'incident_updates',
  'incident_responders',
  'github_repo_feeds',
  'github_links',
  'workspace_invitations',
  'audit_log',
];

/** What an export covers: the workspace, and the channels of it in the export. */
export interface Scope {
  readonly workspaceId: string;
  readonly channelIds: readonly string[];
  /** Every channel, for the operator; or those the asking owner can see (D-140 §1). */
  readonly kind: ExportManifest['scope'];
}

/**
 * The scope's channels, as the database knows them: those of the workspace among the ids given. Every
 * bound goes through this, so an id of another workspace's channel, passed by mistake, selects nothing.
 */
const channelsIn = (scope: Scope): RawBuilder<unknown> =>
  sql`select id from channels where workspace_id = ${scope.workspaceId} and id = any(${scope.channelIds}::uuid[])`;

/** The messages of the scope, which reactions are bounded by. */
const messagesOf = (scope: Scope): RawBuilder<unknown> =>
  sql`select id from messages where workspace_id = ${scope.workspaceId} and channel_id in (${channelsIn(scope)})`;

const incidentsOf = (scope: Scope): RawBuilder<unknown> =>
  sql`select id from incidents where workspace_id = ${scope.workspaceId} and channel_id in (${channelsIn(scope)})`;

/**
 * The people the exported rows name — every column of an exported table that refers to a person,
 * bound to the catalogue's own list by `export.integration.test.ts`.
 */
const PEOPLE = (scope: Scope): RawBuilder<unknown> => sql`
  select user_id from workspace_members where workspace_id = ${scope.workspaceId}
  union select created_by from workspaces where id = ${scope.workspaceId}
  union select created_by from channels where id in (${channelsIn(scope)})
  union select user_id from channel_members where channel_id in (${channelsIn(scope)})
  union select sender_id from messages where id in (${messagesOf(scope)})
  union select resolved_by from messages where id in (${messagesOf(scope)})
  union select question_assignee_id from messages where id in (${messagesOf(scope)})
  union select decision_updated_by from messages where id in (${messagesOf(scope)})
  union select user_id from reactions where message_id in (${messagesOf(scope)})
  union select mentioned_user_id from mentions where message_id in (${messagesOf(scope)})
  union select pinned_by from pinned_messages where message_id in (${messagesOf(scope)})
  union select added_by from channel_bookmarks where channel_id in (${channelsIn(scope)})
  union select uploader_id from attachments where message_id in (${messagesOf(scope)})
  union select declared_by from incidents where id in (${incidentsOf(scope)})
  union select actor_id from incident_updates where incident_id in (${incidentsOf(scope)})
  union select user_id from incident_responders where incident_id in (${incidentsOf(scope)})
  union select added_by from incident_responders where incident_id in (${incidentsOf(scope)})
  union select actor_user_id from audit_log where workspace_id = ${scope.workspaceId}
  union select created_by from workspace_invitations where workspace_id = ${scope.workspaceId}
  union select created_by from github_repo_feeds where channel_id in (${channelsIn(scope)})
  union select created_by from github_links where channel_id in (${channelsIn(scope)})
`;

/** Each table's rows in the scope, and the order they are written in. */
const BOUNDS: Readonly<
  Record<ExportedTable, (scope: Scope) => { where: RawBuilder<unknown>; order: string }>
> = {
  workspaces: (s) => ({ where: sql`id = ${s.workspaceId}`, order: 'id' }),
  users: (s) => ({ where: sql`id in (${PEOPLE(s)})`, order: 'id' }),
  workspace_members: (s) => ({ where: sql`workspace_id = ${s.workspaceId}`, order: 'id' }),
  channels: (s) => ({
    where: sql`id in (${channelsIn(s)})`,
    order: 'id',
  }),
  channel_members: (s) => ({ where: sql`channel_id in (${channelsIn(s)})`, order: 'id' }),
  messages: (s) => ({ where: sql`id in (${messagesOf(s)})`, order: 'id' }),
  reactions: (s) => ({ where: sql`message_id in (${messagesOf(s)})`, order: 'id' }),
  mentions: (s) => ({ where: sql`message_id in (${messagesOf(s)})`, order: 'id' }),
  message_versions: (s) => ({ where: sql`message_id in (${messagesOf(s)})`, order: 'id' }),
  pinned_messages: (s) => ({ where: sql`message_id in (${messagesOf(s)})`, order: 'message_id' }),
  channel_bookmarks: (s) => ({ where: sql`channel_id in (${channelsIn(s)})`, order: 'id' }),
  // An upload not yet sent is the uploader's until then, and gone in a day (D-109 §5).
  attachments: (s) => ({ where: sql`message_id in (${messagesOf(s)})`, order: 'id' }),
  incidents: (s) => ({ where: sql`id in (${incidentsOf(s)})`, order: 'id' }),
  incident_updates: (s) => ({ where: sql`incident_id in (${incidentsOf(s)})`, order: 'id' }),
  incident_responders: (s) => ({
    where: sql`incident_id in (${incidentsOf(s)})`,
    order: 'incident_id, user_id',
  }),
  github_links: (s) => ({ where: sql`channel_id in (${channelsIn(s)})`, order: 'id' }),
  github_repo_feeds: (s) => ({
    where: sql`channel_id in (${channelsIn(s)})`,
    order: 'id',
  }),
  workspace_invitations: (s) => ({ where: sql`workspace_id = ${s.workspaceId}`, order: 'id' }),
  audit_log: (s) => ({ where: sql`workspace_id = ${s.workspaceId}`, order: 'id' }),
};

/** The columns of a table as the export writes them; a member-only column is empty for the rest. */
const projection = (table: ExportedTable, scope: Scope): RawBuilder<unknown> => {
  const parts = Object.entries(COLUMNS[table]).flatMap(([column, kind]) => {
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
): Promise<Readonly<Record<ExportedTable, number>>> => {
  const counted = {} as Record<ExportedTable, number>;
  for (const table of TABLE_ORDER) {
    counted[table] = await readTable(
      transaction,
      table,
      { columns: projection(table, scope), ...BOUNDS[table](scope) },
      sink,
    );
  }
  return counted;
};

/** The shape every row was in, read inside the snapshot: the last migration the database had. */
export const schemaOf = async (transaction: Transaction): Promise<string> => {
  const latest = await sql<{ name: string }>`
    select name from kysely_migration order by name desc limit 1
  `.execute(transaction);
  return latestMigration(latest.rows[0]?.name);
};

/** The channels an operator's export covers: every channel of the workspace, archived ones too. */
export const everyChannel = async (executor: Executor, workspaceId: string): Promise<string[]> =>
  (
    await executor
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .execute()
  ).map((row) => row.id);

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
  where: RawBuilder<unknown>,
): Promise<StoredFile[]> =>
  (
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
  const { database, clock, log, storage } = dependencies;
  const directory = await exportDirectory(target);
  try {
    const { tables, schema, objects } = await snapshotOn(database)(async (transaction) => ({
      schema: await schemaOf(transaction),
      tables: await readTables(transaction, scope, directory.write),
      objects: await filesOf(transaction, sql`message_id in (${messagesOf(scope)})`),
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
    await directory.seal(manifest, TABLE_ORDER);
    // On the trail before it takes its name: an export nobody can find a line for must not exist.
    if (trail === 'here')
      await atomicallyOn(database)(async (transaction) => {
        await recordAudit(transaction, clock, {
          workspaceId: workspace.id,
          actorUserId: null,
          action: 'workspace.exported',
          targetType: 'workspace',
          targetId: workspace.id,
          metadata: { scope: scope.kind, messages: String(tables.messages) },
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
