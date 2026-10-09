/**
 * Users for tests, under names nothing else will hold.
 *
 * Every integration test made its own users under fixed names — `vis-owner`,
 * `msg-alice` — in a database a developer also runs the application against.
 * Rolled back, but still inserted: one workspace or account of the same name,
 * created by hand, and an unrelated test failed on a unique constraint (#202).
 * A random suffix makes that impossible, and the name a test asserts on is the
 * one it is handed back, never the one it asked for.
 *
 * Nine files carried a copy of this; it has one home now. Only the database is
 * known here, so a test in any layer may use it; the session cookie, an HTTP
 * concept, is added in `testing/signed-in.ts`.
 */
import type { Executor } from '@purlay/db';

export interface TestUser {
  readonly userId: string;
  /** What was stored: the name asked for, with a suffix. Assert on this. */
  readonly username: string;
  readonly email: string;
}

/** GitHub's limit, and the column's (`SCHEMA.md`). */
const USERNAME_MAX = 39;

export const aUserRow = async (executor: Executor, name: string): Promise<TestUser> => {
  const username = `${name}-${crypto.randomUUID().slice(0, 6)}`;
  if (username.length > USERNAME_MAX) {
    throw new Error(`a test username must leave room for its suffix: "${name}" is too long`);
  }
  const email = `${username}@example.test`;
  const row = await executor
    .insertInto('users')
    .values({ email, username, display_name: name })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { userId: row.id, username, email };
};

/** A workspace slug no other test, and no developer's own workspace, will hold. */
export const aUniqueSlug = (name: string): string => `${name}-${crypto.randomUUID().slice(0, 6)}`;
