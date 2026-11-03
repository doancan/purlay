/**
 * What a person's export of their own data holds is assembled from contributions, as a workspace's is
 * (D-241, D-250, `catalogue.ts`): the core says what is its own — the person's account, the workspaces their rows
 * name, their memberships — and each module says what is its, table by table and column by column, how each is
 * bounded to the person, and which workspaces its rows name. The exporter reads the assembled catalogue and names
 * no module's table.
 *
 * - **Everything about them goes**: their account's fields (none of which is a secret — the password's hash, the
 *   second step's key and the sessions' tokens live in other tables), their memberships and what they set on
 *   each, and what each module holds of theirs.
 * - **Nothing of anybody else's**: no other person's row, words or name. A row of theirs names other things by
 *   id, and only the workspaces their rows name are written, by id, name and slug, so the ids mean something.
 * - **What is the thread's or the team's, not theirs, stays**, as does the realtime layer's bookkeeping.
 *
 * Every contribution is typed over the generated schema (`Database`, D-45): a column a migration adds is a
 * compile error where its table is described until somebody decides whether a person's own copy carries it. The
 * composition root (`export-catalogue.ts`) holds the sum to the schema.
 */
import { absentTables, sql, type Database, type Executor, type RawBuilder } from '@purlay/db';
import type { Bounds } from './catalogue';

/** A column: in a person's export, or left out. */
type PersonalColumn = 'export' | 'omit';

type PersonalColumnsOf<T extends keyof Database> = {
  readonly [C in keyof Database[T]]: PersonalColumn;
};

/**
 * One table of a person's export. `workspaces` is every workspace the catalogue's contributions say the
 * person's rows name, which the workspaces' own table is bounded by.
 */
export interface PersonalTableExport {
  readonly name: keyof Database;
  readonly columns: Readonly<Record<string, PersonalColumn>>;
  /** Given the executor of the snapshot, for a bound that depends on which of a module's tables the database has. */
  readonly bounds: (
    userId: string,
    workspaces: RawBuilder<unknown>,
    executor: Executor,
  ) => Bounds | Promise<Bounds>;
}

/** Describes one table, its columns held to the schema's, and how it is bounded to the person. */
export const personalTableExport = <T extends keyof Database>(
  name: T,
  columns: PersonalColumnsOf<T>,
  bounds: PersonalTableExport['bounds'],
): PersonalTableExport & { readonly name: T } => ({ name, columns, bounds });

/** The rows of a table whose `column` names the person, in the order of their `id`: what a person made or owns. */
export const ownedBy =
  (column: string): PersonalTableExport['bounds'] =>
  (userId) => ({ where: sql`${sql.ref(column)} = ${userId}`, order: 'id' });

/** The workspaces the rows of a table with a `workspace_id` of its own name, where `column` is the person: for `workspaces`. */
export const workspacesOwnedBy = <T extends keyof Database>(
  table: T,
  column: keyof Database[T] & string,
  userId: string,
): RawBuilder<unknown> =>
  sql`select workspace_id from ${sql.table(table)} where ${sql.ref(column)} = ${userId}`;

/** What a module adds to a person's export. */
export interface PersonalContribution {
  readonly id: string;
  /** Its tables, in the order they are written: parents before their children. */
  readonly tables: readonly PersonalTableExport[];
  /** The tables its own migration set makes, absent from a database migrated without the set: not read, and its workspaces not asked for. */
  readonly ownSet?: readonly (keyof Database)[];
  /** Each a `select <workspace's id> from …` over the person's rows: the workspaces they name. */
  readonly workspaces: (userId: string) => readonly RawBuilder<unknown>[];
  /** A bound on `attachments` selecting the files the person sent, whose bytes the export copies. */
  readonly files?: (userId: string, executor: Executor) => Promise<RawBuilder<unknown>>;
}

/**
 * What the core contributes: the tables that come before the modules' and those that come after, so a reader
 * meets who, then where, then what they did there.
 */
export interface CorePersonalContribution extends PersonalContribution {
  readonly head: readonly PersonalTableExport[];
  readonly tail: readonly PersonalTableExport[];
}

/** The sum of the contributions, ready to read. */
export interface PersonalCatalogue {
  /** The tables, in the order the files are written. */
  readonly order: readonly (keyof Database)[];
  readonly table: (name: keyof Database) => PersonalTableExport;
  /** The workspaces any of the person's exported rows name. */
  readonly workspaces: (
    userId: string,
    absent?: readonly (keyof Database)[],
  ) => RawBuilder<unknown>;
  /** Which of the modules' own tables this database does not have: asked once, when the export starts. */
  readonly absent: (executor: Executor) => Promise<readonly (keyof Database)[]>;
  /** The files the person sent, for the bound on `attachments`; none when nothing contributes one. */
  readonly files: (userId: string, executor: Executor) => Promise<RawBuilder<unknown> | undefined>;
}

export const assemblePersonalCatalogue = (
  core: CorePersonalContribution,
  modules: readonly PersonalContribution[],
): PersonalCatalogue => {
  const contributions = [core, ...modules];
  const tables = [...core.head, ...modules.flatMap((module) => module.tables), ...core.tail];
  const byName = new Map(tables.map((table) => [table.name, table]));
  if (byName.size !== tables.length) {
    const names = tables.map((table) => table.name);
    const twice = names.filter((name, index) => names.indexOf(name) !== index);
    throw new Error(
      `the personal export catalogue names a table twice: ${[...new Set(twice)].join(', ')}`,
    );
  }
  return {
    order: tables.map((table) => table.name),
    table: (name: keyof Database): PersonalTableExport => {
      const found = byName.get(name);
      if (found === undefined)
        throw new Error(`the personal export catalogue has no table ${name}`);
      return found;
    },
    workspaces: (userId: string, absent = []): RawBuilder<unknown> =>
      sql.join(
        contributions
          .filter(
            (contribution) => !(contribution.ownSet ?? []).some((own) => absent.includes(own)),
          )
          .flatMap((contribution) => contribution.workspaces(userId)),
        sql` union `,
      ),
    absent: async (executor: Executor): Promise<readonly (keyof Database)[]> =>
      await absentTables(
        executor,
        contributions.flatMap((contribution) => contribution.ownSet ?? []),
      ),
    files: async (userId: string, executor: Executor): Promise<RawBuilder<unknown> | undefined> =>
      await modules.find((module) => module.files !== undefined)?.files?.(userId, executor),
  };
};
