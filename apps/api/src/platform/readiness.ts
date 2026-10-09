/**
 * Whether this process should receive traffic (`API.md` §8, #108).
 *
 * Liveness is "the process answers"; readiness is "it can do its job". Four
 * things decide it, each a way a deployment can be up and still wrong:
 *
 * - **the database answers** — a pool that cannot reach it serves only errors;
 * - **the applied migrations are the files this code ships** — an edited, missing
 *   or out-of-order migration means the schema is not the one the code was written
 *   against, which the migrator refuses to run past and readiness must not hide (D-86);
 * - **every migration is applied** — code ahead of its schema fails on the first
 *   query that touches what is missing;
 * - **the identifier columns compare byte-wise.** They declare `COLLATE "C"` so
 *   that `lower()` and uniqueness do not depend on how the operator ran `initdb`
 *   — under a Turkish locale `lower('İ')` is not `i`, and two channel names that
 *   collide on one server coexist on another (D-40). A schema restored or
 *   hand-built without the clause looks healthy and is not.
 *
 * The answer to the caller is a word; the reason is the log's. Health endpoints
 * disclose nothing about dependencies (`API.md` §8).
 */
import { migrationHistoryProblem, pendingMigrations, sql, type Executor } from '@purlay/db';

/**
 * The columns the migrations declare `COLLATE "C"`. Repeated here because a
 * running process cannot read its migrations' text; bound to them by a test, so
 * a new collated column cannot be added without being checked.
 */
export const COLLATED_COLUMNS: readonly (readonly [table: string, column: string])[] = [
  ['users', 'email'],
  ['users', 'username'],
  ['workspaces', 'slug'],
  ['channels', 'name'],
];

export type Readiness =
  { readonly ready: true } | { readonly ready: false; readonly reason: string };

export const readiness = async (database: Executor): Promise<Readiness> => {
  try {
    const history = await migrationHistoryProblem(database);
    if (history !== undefined) return { ready: false, reason: history };

    const pending = await pendingMigrations(database);
    if (pending.length > 0) {
      return { ready: false, reason: `migrations not applied: ${pending.join(', ')}` };
    }

    const { rows } = await sql<{
      table_name: string;
      column_name: string;
      collation_name: string | null;
    }>`
      select table_name, column_name, collation_name
      from information_schema.columns
      where table_schema = current_schema()
    `.execute(database);
    const collation = new Map(
      rows.map((row) => [`${row.table_name}.${row.column_name}`, row.collation_name]),
    );
    const wrong = COLLATED_COLUMNS.map(([table, column]) => `${table}.${column}`).filter(
      (column) => collation.get(column) !== 'C',
    );
    if (wrong.length > 0) {
      return {
        ready: false,
        reason: `columns that must compare byte-wise do not (COLLATE "C", D-40): ${wrong.join(', ')}`,
      };
    }
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      reason: `the database did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
