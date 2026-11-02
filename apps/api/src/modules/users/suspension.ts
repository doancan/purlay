/**
 * Suspending an account, and lifting it (D-233): the server's administrator's, for somebody who has left.
 *
 * - **What it is.** `users.suspended_at` set, and every session of the account deleted in the same
 *   transaction; the caller publishes their ends after the commit, so each socket is closed. Nothing else
 *   changes: memberships, messages, the name in every conversation stay, so lifting it is the person as
 *   they were. A suspended account starts no session by any way in, and resolves none
 *   (`auth/better-auth.ts`, `auth/sessions.ts`).
 * - **Not the administrator's own, nor another administrator's.** An administrator who suspends
 *   themself, or the last one, locks the server's administration out; a second administrator is the
 *   operator's to demote first (`bun run admin:reset-password` is the break-glass). `403 FORBIDDEN`.
 * - **An account that is not there is `404 USER_NOT_FOUND`**: never made, erased, or not an id.
 * - **Each is on the server's trail** with whose account it was (`server.account_suspended`,
 *   `server.account_restored`). Suspending one already suspended, or lifting one that is not, changes
 *   and records nothing.
 */
import { sql, type Executor, type Transaction } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { SERVER_ACCOUNTS_MAX, Uuid, type ServerAccount } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { revokeAllSessions } from '../auth/sessions';
import { recordServerAudit } from '../audit/server-audit';
import { literalPattern } from '../search/search';
import type { ServerAdminSession } from '../setup/setup';

const accountNotFound = (): AppError =>
  new AppError({ code: 'USER_NOT_FOUND', message: 'No such account.' });

/**
 * The accounts the administrator finds by name, username or address, in the order a person reads a
 * list of people; erased ones are not accounts. At most `SERVER_ACCOUNTS_MAX`: a search, not a census.
 */
export const serverAccounts = async (
  executor: Executor,
  _admin: ServerAdminSession,
  words: string,
): Promise<ServerAccount[]> => {
  let statement = executor
    .selectFrom('users')
    .select(['id', 'username', 'display_name', 'email', 'is_server_admin', 'suspended_at'])
    .where('deleted_at', 'is', null)
    .orderBy(sql`lower(display_name)`)
    .orderBy('id')
    .limit(SERVER_ACCOUNTS_MAX);
  const typed = words.trim();
  if (typed !== '') {
    const pattern = literalPattern(typed);
    statement = statement.where((eb) =>
      eb.or([
        eb('display_name', 'ilike', pattern),
        eb('username', 'ilike', pattern),
        eb('email', 'ilike', pattern),
      ]),
    );
  }
  return (await statement.execute()).map((row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    isServerAdmin: row.is_server_admin,
    suspendedAt: row.suspended_at === null ? null : new Date(row.suspended_at).toISOString(),
  }));
};

/** The account, locked for the change: one that exists and is not erased. */
const lockAccount = async (
  executor: Transaction,
  userId: string,
): Promise<{ readonly isServerAdmin: boolean; readonly suspended: boolean }> => {
  if (!Value.Check(Uuid, userId)) throw accountNotFound();
  const row = await executor
    .selectFrom('users')
    .select(['is_server_admin', 'suspended_at'])
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (row === undefined) throw accountNotFound();
  return { isServerAdmin: row.is_server_admin, suspended: row.suspended_at !== null };
};

/** Suspends the account; returns the sessions it ended, for the caller to close their sockets. */
export const suspendAccount = async (
  executor: Transaction,
  clock: Clock,
  admin: ServerAdminSession,
  userId: string,
): Promise<readonly string[]> => {
  const account = await lockAccount(executor, userId);
  if (userId === admin.userId || account.isServerAdmin) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'An administrator of the server is not suspended here.',
    });
  }
  if (account.suspended) return [];
  await executor
    .updateTable('users')
    .set({ suspended_at: clock.now() })
    .where('id', '=', userId)
    .execute();
  const ended = await revokeAllSessions(executor, userId);
  await recordServerAudit(executor, clock, {
    actorUserId: admin.userId,
    action: 'server.account_suspended',
    targetUserId: userId,
  });
  return ended;
};

/** Lifts the suspension: the account may sign in again, as it was. */
export const restoreAccount = async (
  executor: Transaction,
  clock: Clock,
  admin: ServerAdminSession,
  userId: string,
): Promise<void> => {
  const account = await lockAccount(executor, userId);
  if (!account.suspended) return;
  await executor
    .updateTable('users')
    .set({ suspended_at: null })
    .where('id', '=', userId)
    .execute();
  await recordServerAudit(executor, clock, {
    actorUserId: admin.userId,
    action: 'server.account_restored',
    targetUserId: userId,
  });
};
