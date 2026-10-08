/**
 * The transaction boundary, as a value.
 *
 * A service that must write atomically takes `Atomically` rather than calling
 * `transaction()` itself, for the reason D-46 makes every executor an argument:
 * a function that opens its own transaction cannot run inside a caller's.
 */
import type { Executor } from '@purlay/db';

export type Atomically = <T>(body: (executor: Executor) => Promise<T>) => Promise<T>;

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
    executor.isTransaction ? await body(executor) : await executor.transaction().execute(body);
