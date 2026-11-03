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
import { sql, type Database, type Executor, type RawBuilder } from '@purlay/db';
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
        contributions.flatMap((contribution) => contribution.people(scope)),
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
      return { workspaceId: request.workspaceId, kind: request.kind, prepared };
    },
    audit: (rows: Readonly<Record<string, number>>): Readonly<Record<string, string>> => {
      const added: Record<string, string> = {};
      for (const contribution of contributions) Object.assign(added, contribution.audit?.(rows));
      return added;
    },
  };
};
