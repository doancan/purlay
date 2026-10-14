/**
 * The transaction boundary, as a value.
 *
 * A service that must write atomically takes `Atomically` rather than calling
 * `transaction()` itself, for the reason D-46 makes every executor an argument:
 * a function that opens its own transaction cannot run inside a caller's.
 *
 * The body receives a `Transaction`, not an `Executor`, and a service that writes
 * more than once takes the same type. The pool is therefore not an argument it
 * can be handed: forgetting the boundary is a compile error, not a comment
 * asking a reviewer to notice (#232, D-77).
 */
import { isTransaction, type Executor, type Transaction } from '@purlay/db';

export type Atomically = <T>(body: (transaction: Transaction) => Promise<T>) => Promise<T>;

/**
 * Runs the body in a transaction: the caller's, if it is already inside one,
 * otherwise a new one that commits when the body returns.
 *
 * Joining rather than nesting is the propagation every caller here needs — a
 * request handler never holds a transaction, and a test always does (D-46). It is
 * decided by the executor itself, not by a flag somebody passes, so the code that
 * runs in a test is the code that runs in production.
 */
export const atomicallyOn =
  (executor: Executor): Atomically =>
  async (body) =>
    isTransaction(executor) ? await body(executor) : await executor.transaction().execute(body);

/**
 * Runs the body in one read-only snapshot (`REPEATABLE READ READ ONLY`): every statement sees the
 * database as it was at the first, whatever commits meanwhile. Joins the caller's transaction when
 * there is one — a test's, which is a snapshot of its own rows (D-46).
 */
export const snapshotOn =
  (executor: Executor): Atomically =>
  async (body) =>
    isTransaction(executor)
      ? await body(executor)
      : await executor
          .transaction()
          .setIsolationLevel('repeatable read')
          .setAccessMode('read only')
          .execute(body);
