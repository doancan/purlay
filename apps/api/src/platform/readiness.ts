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
 * - **the sign-in library finds the tables it expects** — asked last, once every migration is in,
 *   since its verdict on a mismatch is kept until the process restarts; the library itself only
 *   logs one and fails each sign-in, so a server whose sign-in cannot work would otherwise look
 *   ready (D-179). The caller hands the check in: this file knows no module.
 *
 * The answer to the caller is a word; the reason is the log's. Health endpoints
 * disclose nothing about dependencies (`API.md` §8).
 */
import { migrationHistoryProblem, pendingMigrations, sql, type Executor } from '@purlay/db';
import type { Clock } from './clock';

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
  ['github_repo_feeds', 'repository_full_name'],
  ['github_deliveries', 'delivery_id'],
];

export type Readiness =
  { readonly ready: true } | { readonly ready: false; readonly reason: string };

/** A check beyond the database's own, answering a reason when it fails and nothing when it holds. */
export type ReadinessCheck = () => Promise<string | undefined>;

/**
 * A reason this node should not take traffic, answered at once and from what is already known: whether a
 * shared Redis, when one is configured, has been reached since start (D-201).
 */
export type SharedProblem = () => string | undefined;

export const readiness = async (
  database: Executor,
  signIn?: ReadinessCheck,
  shared?: SharedProblem,
): Promise<Readiness> => {
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
    const signInProblem = await signIn?.();
    if (signInProblem !== undefined) return { ready: false, reason: signInProblem };
    // Only a Redis never reached: a node that has been up and lost it serves on, degraded, and says so in
    // the log. Every node refusing traffic because the shared piece blinked would be the outage (D-201).
    const sharedProblem = shared?.();
    if (sharedProblem !== undefined) return { ready: false, reason: sharedProblem };
    return { ready: true };
  } catch (error) {
    return {
      ready: false,
      reason: `the database did not answer: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

/**
 * How old a readiness answer may be and still be given. Readiness runs several queries, and the
 * endpoint is public — the proxy's check, the image's, and an external uptime monitor (`PRD.md` §5)
 * all ask it — so asked a thousand times a second it would be a thousand checks (#636). A second is
 * shorter than any of those checks' own interval, so none of them reads a stale answer twice.
 */
export const READINESS_FRESH_MS = 1_000;

/**
 * Readiness as the endpoint gives it: one check at a time however many ask, and its answer reused
 * while younger than `freshMs`. A not-ready answer is reused the same way; draining is decided by the
 * caller before this is asked, so a shutdown is never hidden behind a cached "ready".
 */
export const recentReadiness = (
  check: () => Promise<Readiness>,
  clock: Clock,
  freshMs: number = READINESS_FRESH_MS,
): (() => Promise<Readiness>) => {
  let last: { readonly at: number; readonly answer: Readiness } | null = null;
  let asking: Promise<Readiness> | null = null;
  return async () => {
    if (last !== null && clock.now().getTime() - last.at < freshMs) return last.answer;
    asking ??= check()
      .then((answer) => {
        last = { at: clock.now().getTime(), answer };
        return answer;
      })
      .finally(() => {
        asking = null;
      });
    return await asking;
  };
};
