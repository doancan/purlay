/**
 * The administrator's view of the outbox (D-288 §11). Listing is metadata and reads nothing it need not; reading one fact whole
 * shows its payload to the administrator and only to them, and is written on the server's trail by the fact's id in the same
 * transaction as the read, after the administrator is rechecked under the lock every authority change takes: a read that is not
 * on the trail did not happen, and one by an administrator demoted a moment ago did not either.
 */
import type { Executor, Transaction } from '@purlay/db';
import type { ServerOutboxFactDetail, ServerOutboxPage, ServerOutboxQuery } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { listOutboxFacts, readOutboxFact } from '../../platform/outbox-operate';
import { recordServerAudit } from '../audit/server-audit';
import type { ServerAdminSession } from '../setup/setup';
import { lockServerAdministrator } from './changes';

export const listServerOutbox = async (
  database: Executor,
  clock: Clock,
  query: ServerOutboxQuery,
): Promise<ServerOutboxPage> => await listOutboxFacts(database, query, clock.now());

export const inspectServerOutboxFact = async (
  tx: Transaction,
  clock: Clock,
  admin: ServerAdminSession,
  id: string,
): Promise<ServerOutboxFactDetail> => {
  await lockServerAdministrator(tx, admin);
  const fact = await readOutboxFact(tx, id);
  if (fact === undefined) throw new AppError({ code: 'ROUTE_NOT_FOUND', message: 'No such fact.' });
  await recordServerAudit(tx, clock, {
    actorUserId: admin.userId,
    action: 'server.fact_inspected',
    targetFactId: fact.factId,
    targetWorkspaceId: fact.workspaceId,
    targetModule: fact.consumer,
  });
  return fact;
};
