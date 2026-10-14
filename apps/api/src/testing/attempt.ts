/**
 * An attempt a test expects may be refused, inside the test's rolled-back transaction (D-46): run in
 * a savepoint, so a refusal — which aborts the transaction in PostgreSQL — does not end the test's.
 */
import { sql, type Executor } from '@purlay/db';
import { AppError } from '../platform/errors';

/** What the attempt came to: its value, or what it was refused with. */
export type Outcome<T> =
  { readonly taken: true; readonly value: T } | { readonly taken: false; readonly error: unknown };

/** Runs one attempt in a savepoint: kept when it goes through, rolled back when it is refused. */
export const inSavepoint = async <T>(db: Executor, run: () => Promise<T>): Promise<Outcome<T>> => {
  await sql`savepoint attempt`.execute(db);
  const outcome = await run().then(
    (value): Outcome<T> => ({ taken: true, value }),
    (error: unknown): Outcome<T> => ({ taken: false, error }),
  );
  await sql`${sql.raw(outcome.taken ? 'release' : 'rollback to')} savepoint attempt`.execute(db);
  return outcome;
};

/** The refusal's code — an `AppError`'s, or the error said whole — or `taken` when it went through. */
export const attempt = async (db: Executor, run: () => Promise<unknown>): Promise<string> => {
  const outcome = await inSavepoint(db, run);
  if (outcome.taken) return 'taken';
  return outcome.error instanceof AppError ? outcome.error.body.code : String(outcome.error);
};
