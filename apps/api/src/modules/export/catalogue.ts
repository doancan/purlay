/**
 * What a workspace export holds is assembled from contributions (D-250, `MODULES.md` §2): the core says what is
 * its own — the workspace, its people, its trail — and each module says what is its, table by table and column
 * by column, how each is bounded to the workspace, and which of the people the rows name are its to name. The
 * exporter reads the assembled catalogue and names no module's table.
 *
 * Every contribution is typed over the generated schema (`Database`, D-45): a column a migration adds to a
 * table is a compile error where that table is described until somebody decides whether it leaves the server —
 * a secret added later cannot ride out unseen. The composition root (`export-catalogue.ts`) holds the sum to
 * the schema: a table nobody decided is a compile error there, and `catalogue.integration.test.ts` holds it to
 * the database.
 */
import { absentTables, sql, type Database, type Executor, type RawBuilder } from '@purlay/db';
import type { ExportManifest } from '@purlay/types';
import type { WorkspaceContext } from '../../platform/tenancy';

/**
 * A column: in the export, left out, only for current members, or — the address — only for current
 * members and only in the operator's export (D-140 §3).
 */
type Column = 'export' | 'omit' | 'members' | 'operator';

export type ColumnsOf<T extends keyof Database> = { readonly [C in keyof Database[T]]: Column };

/** What an export covers: the workspace, and what each module chose to cover of it. */
export interface Scope {
  readonly workspaceId: string;
  /** Every channel, for the operator; or those the asking owner can see (D-140 §1). */
  readonly kind: ExportManifest['scope'];
  /** What each contribution's `prepare` answered, by its id. */
  readonly prepared: Readonly<Record<string, unknown>>;
  /**
   * The tables of a module's own set that this database does not have, found when the scope was made: they are not read,
   * and what the module says of the people they name is left out (`ExportContribution.ownSet`).
   */
  readonly absent?: readonly (keyof Database)[];
}

/** Who asks, as far as what is covered depends on it. */
type ScopeRequest =
  | { readonly kind: 'all'; readonly workspaceId: string }
  | {
      readonly kind: 'visible-to-owner';
      readonly workspaceId: string;
      readonly viewer: WorkspaceContext;
    };

/** The rows of a table in the scope, and the order they are written in. */
export interface Bounds {
  readonly where: RawBuilder<unknown>;
  readonly order: string;
}

/**
 * One table of an export. `people` is every person the catalogue's contributions name, which the people's own
 * table is bounded by.
 */
export interface TableExport {
  readonly name: keyof Database;
  readonly columns: Readonly<Record<string, Column>>;
  readonly bounds: (scope: Scope, people: RawBuilder<unknown>) => Bounds;
}

/**
 * The rows of a table that carries a `workspace_id` of its own, which is how a module's table says whose it is: the
 * workspace's, in the order of its `id`. A module that bounds a table this way names no SQL of its own.
 */
export const inWorkspace = (scope: Scope): Bounds => ({
  where: sql`workspace_id = ${scope.workspaceId}`,
  order: 'id',
});

/** The people a column of such a table names, for `people`: each a `select <person's id> from …`. */
export const namedInWorkspace = <T extends keyof Database>(
  table: T,
  column: keyof Database[T] & string,
  scope: Scope,
): RawBuilder<unknown> =>
  sql`select ${sql.ref(column)} from ${sql.table(table)} where workspace_id = ${scope.workspaceId}`;

/** Describes one table, its columns held to the schema's, and how it is bounded. */
export const tableExport = <T extends keyof Database>(
  name: T,
  columns: ColumnsOf<T>,
  bounds: TableExport['bounds'],
): TableExport & { readonly name: T } => ({ name, columns, bounds });

/** What a module adds to a workspace's export. */
export interface ExportContribution {
  readonly id: string;
  /** Its tables, in the order they are written: parents before their children. */
  readonly tables: readonly TableExport[];
  /**
   * The tables its own migration set makes, which a database migrated without the set does not have. Where one is not
   * there nothing is read from it and its people are not asked for: there is nothing to export (`MODULES.md` §5).
   */
  readonly ownSet?: readonly (keyof Database)[];
  /** Each a `select <person's id> from …` over what the scope covers: the people its rows name. */
  readonly people: (scope: Scope) => readonly RawBuilder<unknown>[];
  /** Decides what it covers of the workspace, before the snapshot is taken. */
  readonly prepare?: (executor: Executor, request: ScopeRequest) => Promise<unknown>;
  /** A bound on `attachments` selecting the files of what it covers, whose bytes the export copies. */
  readonly files?: (scope: Scope) => RawBuilder<unknown>;
  /** What it adds to the line the export leaves on the trail, from the rows written. */
  readonly audit?: (rows: Readonly<Record<string, number>>) => Readonly<Record<string, string>>;
}

/**
 * What the core contributes: the tables that come before the modules' and those that come after, so a reader
 * re-importing the files meets parents before their children.
 */
export interface CoreExportContribution extends ExportContribution {
  readonly head: readonly TableExport[];
  readonly tail: readonly TableExport[];
}

/** The sum of the contributions, ready to read. */
export interface Catalogue {
  /** The tables, in the order the files are written. */
  readonly order: readonly (keyof Database)[];
  readonly table: (name: keyof Database) => TableExport;
  /** The people any of the exported rows name. */
  readonly people: (scope: Scope) => RawBuilder<unknown>;
  /** The files of everything covered, for the bound on `attachments`; none when nothing contributes one. */
  readonly files: (scope: Scope) => RawBuilder<unknown> | undefined;
  readonly scopeOf: (executor: Executor, request: ScopeRequest) => Promise<Scope>;
  readonly audit: (rows: Readonly<Record<string, number>>) => Readonly<Record<string, string>>;
}

/** Whether any of a module's own tables is among those a database lacks. */
const lacks = (
  own: readonly (keyof Database)[] | undefined,
  absent: readonly (keyof Database)[] | undefined,
): boolean => (own ?? []).some((table) => absent?.includes(table) === true);

export const assembleCatalogue = (
  core: CoreExportContribution,
  modules: readonly ExportContribution[],
): Catalogue => {
  const contributions = [core, ...modules];
  const tables = [...core.head, ...modules.flatMap((module) => module.tables), ...core.tail];
  const byName = new Map(tables.map((table) => [table.name, table]));
  if (byName.size !== tables.length) {
    const names = tables.map((table) => table.name);
    const twice = names.filter((name, index) => names.indexOf(name) !== index);
    throw new Error(`the export catalogue names a table twice: ${[...new Set(twice)].join(', ')}`);
  }
  return {
    order: tables.map((table) => table.name),
    table: (name: keyof Database): TableExport => {
      const found = byName.get(name);
      if (found === undefined) throw new Error(`the export catalogue has no table ${name}`);
      return found;
    },
    people: (scope: Scope): RawBuilder<unknown> =>
      sql.join(
        contributions
          .filter((contribution) => !lacks(contribution.ownSet, scope.absent))
          .flatMap((contribution) => contribution.people(scope)),
        sql` union `,
      ),
    files: (scope: Scope): RawBuilder<unknown> | undefined =>
      modules.find((module) => module.files !== undefined)?.files?.(scope),
    scopeOf: async (executor: Executor, request: ScopeRequest): Promise<Scope> => {
      const prepared: Record<string, unknown> = {};
      for (const contribution of contributions) {
        if (contribution.prepare !== undefined) {
          prepared[contribution.id] = await contribution.prepare(executor, request);
        }
      }
      const absent = await absentTables(
        executor,
        contributions.flatMap((contribution) => contribution.ownSet ?? []),
      );
      return { workspaceId: request.workspaceId, kind: request.kind, prepared, absent };
    },
    audit: (rows: Readonly<Record<string, number>>): Readonly<Record<string, string>> => {
      const added: Record<string, string> = {};
      for (const contribution of contributions) Object.assign(added, contribution.audit?.(rows));
      return added;
    },
  };
};
