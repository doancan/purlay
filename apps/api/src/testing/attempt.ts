/**
 * An attempt a test expects may be refused, inside the test's rolled-back transaction (D-46): run in
 * a savepoint, so a refusal — which aborts the transaction in PostgreSQL — does not end the test's.
 * Answers the refusal's code, or `taken` when it went through.
 */
import { sql, type Executor } from '@purlay/db';
import { AppError } from '../platform/errors';

export const attempt = async (db: Executor, run: () => Promise<unknown>): Promise<string> => {
  await sql`savepoint attempt`.execute(db);
  const code = await run().then(
    () => 'taken',
    (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
  );
  await sql`${sql.raw(code === 'taken' ? 'release' : 'rollback to')} savepoint attempt`.execute(db);
  return code;
};
