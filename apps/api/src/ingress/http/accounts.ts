/**
 * Administration → Server → Accounts (D-233): the server's administrator finds an account, suspends it
 * and lifts it. Behind `requireServerAdmin`, so to anybody else each route is absent (`404 ROUTE_NOT_FOUND`).
 */
import type { Executor } from '@purlay/db';
import { ServerAccountsQuery, type ServerAccountList } from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';
import { requireServerAdmin } from '../../modules/setup/setup';
import { restoreAccount, serverAccounts, suspendAccount } from '../../modules/users/suspension';
import type { Clock } from '../../platform/clock';
import {
  publication,
  publishAfterCommit,
  publishSessionsEnded,
  type EventBus,
} from '../../platform/events';
import type { Logger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import { queryOf, validated } from './validate';

export interface AccountDependencies {
  readonly auth: Auth;
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly bus: EventBus;
}

/** `GET /api/server/accounts?q=` — accounts by name, username or address, at most `SERVER_ACCOUNTS_MAX`. */
export const readServerAccounts = async (
  dependencies: AccountDependencies,
  request: Request,
): Promise<ServerAccountList> => {
  const admin = await requireServerAdmin(dependencies.auth, dependencies.database, request.headers);
  const { q } = validated(ServerAccountsQuery, queryOf(new URL(request.url)));
  return await serverAccounts(dependencies.database, admin, q ?? '');
};

/**
 * `PUT /api/server/accounts/:userId/suspension` — suspended; `204`. Every socket of every session it
 * had is told and closed, after the commit.
 */
export const suspend = async (
  dependencies: AccountDependencies,
  request: Request,
  userId: string,
): Promise<void> => {
  const { database, clock, bus, log } = dependencies;
  const admin = await requireServerAdmin(dependencies.auth, database, request.headers);
  const ended = await atomicallyOn(database)(
    async (transaction) => await suspendAccount(transaction, clock, admin, userId),
  );
  await publishAfterCommit(log, [
    [publication('SESSION_ENDED', () => publishSessionsEnded(bus, clock, ended))],
  ]);
};

/** `DELETE /api/server/accounts/:userId/suspension` — lifted; `204`. */
export const lift = async (
  dependencies: AccountDependencies,
  request: Request,
  userId: string,
): Promise<void> => {
  const admin = await requireServerAdmin(dependencies.auth, dependencies.database, request.headers);
  await atomicallyOn(dependencies.database)(async (transaction) => {
    await restoreAccount(transaction, dependencies.clock, admin, userId);
  });
};
