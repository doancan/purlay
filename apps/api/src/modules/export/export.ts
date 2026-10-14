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
import type { Executor, Transaction } from '@purlay/db';
import { EXPORT_FORMAT, type ExportManifest } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import { atomicallyOn, snapshotOn } from '../../platform/transactions';
import { recordAudit } from '../audit/audit';
import { exportDirectory } from './write';
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
  'attachments',
  'incidents',
  'incident_updates',
  'incident_responders',
  'github_repo_feeds',
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
  union select user_id from reactions where message_id in (${messagesOf(scope)})
  union select mentioned_user_id from mentions where message_id in (${messagesOf(scope)})
  union select pinned_by from pinned_messages where message_id in (${messagesOf(scope)})
  union select uploader_id from attachments where message_id in (${messagesOf(scope)})
  union select declared_by from incidents where id in (${incidentsOf(scope)})
  union select actor_id from incident_updates where incident_id in (${incidentsOf(scope)})
  union select user_id from incident_responders where incident_id in (${incidentsOf(scope)})
  union select added_by from incident_responders where incident_id in (${incidentsOf(scope)})
  union select actor_user_id from audit_log where workspace_id = ${scope.workspaceId}
  union select created_by from workspace_invitations where workspace_id = ${scope.workspaceId}
  union select created_by from github_repo_feeds where channel_id in (${channelsIn(scope)})
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
  // An upload not yet sent is the uploader's until then, and gone in a day (D-109 §5).
  attachments: (s) => ({ where: sql`message_id in (${messagesOf(s)})`, order: 'id' }),
  incidents: (s) => ({ where: sql`id in (${incidentsOf(s)})`, order: 'id' }),
  incident_updates: (s) => ({ where: sql`incident_id in (${incidentsOf(s)})`, order: 'id' }),
  incident_responders: (s) => ({
    where: sql`incident_id in (${incidentsOf(s)})`,
    order: 'incident_id, user_id',
  }),
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
export type LineSink = (table: ExportedTable, lines: readonly string[]) => Promise<void>;

/** Reads every table of the scope inside the transaction it is given, handing the lines on. */
export const readTables = async (
  transaction: Transaction,
  scope: Scope,
  sink: LineSink,
): Promise<Readonly<Record<ExportedTable, number>>> => {
  const counted = {} as Record<ExportedTable, number>;
  for (const table of TABLE_ORDER) {
    const { where, order } = BOUNDS[table](scope);
    const cursor = `export_${table}`;
    await sql`declare ${sql.raw(cursor)} no scroll cursor for
      select row_to_json(t)::text as line from (
        select ${projection(table, scope)} from ${sql.table(table)} where ${where} order by ${sql.raw(order)}
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
    counted[table] = rows;
  }
  return counted;
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
 * Exports the workspace into `target` (D-140): the tables in one snapshot, the files written as they
 * come, the manifest last, and one line on the workspace's trail once the export exists.
 */
export const exportWorkspace = async (
  dependencies: { readonly database: Executor; readonly clock: Clock; readonly log: Logger },
  workspace: { readonly id: string; readonly slug: string; readonly name: string },
  scope: Scope,
  target: string,
): Promise<{ readonly path: string; readonly manifest: ExportManifest }> => {
  const { database, clock, log } = dependencies;
  const directory = await exportDirectory(target);
  try {
    const { tables, schema } = await snapshotOn(database)(async (transaction) => {
      const latest = await sql<{ name: string }>`
        select name from kysely_migration order by name desc limit 1
      `.execute(transaction);
      return {
        schema: latestMigration(latest.rows[0]?.name),
        tables: await readTables(transaction, scope, directory.write),
      };
    });
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      exportedAt: clock.now().toISOString(),
      workspace,
      schema,
      scope: scope.kind,
      tables,
    };
    await directory.seal(manifest, TABLE_ORDER);
    // On the trail before it takes its name: an export nobody can find a line for must not exist.
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
    log.info('workspace exported', { workspaceId: workspace.id, rows: tables });
    return { path, manifest };
  } catch (error) {
    await directory.abandon();
    throw error;
  }
};
