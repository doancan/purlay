/**
 * The administrator's view of the outbox (D-288 §12). Listing is metadata and reads nothing it need not; reading one fact whole
 * shows its payload to the administrator and only to them, and is written on the server's trail by the fact's id in the same
 * transaction as the read, after the administrator is rechecked under the lock every authority change takes: a read that is not
 * on the trail did not happen, and one by an administrator demoted a moment ago did not either.
 */
import type { Executor, Transaction } from '@purlay/db';
import type {
  ServerOutboxChangeRequest,
  ServerOutboxChangeResponse,
  ServerOutboxFactDetail,
  ServerOutboxPage,
  ServerOutboxQuery,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import {
  changeOutboxFacts,
  listOutboxFacts,
  readOutboxFact,
  type OutboxChange,
} from '../../platform/outbox-operate';
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

const ACTIONS = { requeue: 'server.fact_requeued', discard: 'server.fact_discarded' } as const;

/**
 * Requeues or discards deliveries, each change on the server's trail with the administrator's reason in the transaction of the
 * change (D-288 §12). A repeat changes nothing and records nothing, so a double submission is one change and one entry for each
 * delivery; the administrator is rechecked under the lock first.
 */
export const changeServerOutbox = async (
  tx: Transaction,
  clock: Clock,
  admin: ServerAdminSession,
  change: OutboxChange,
  input: ServerOutboxChangeRequest,
): Promise<ServerOutboxChangeResponse> => {
  await lockServerAdministrator(tx, admin);
  const { verdicts, changed } = await changeOutboxFacts(tx, change, input.ids, clock.now());
  for (const fact of changed)
    await recordServerAudit(tx, clock, {
      actorUserId: admin.userId,
      action: ACTIONS[change],
      targetFactId: fact.factId,
      targetWorkspaceId: fact.workspaceId,
      targetModule: fact.consumer,
      note: input.reason.trim(),
    });
  return { results: [...verdicts] };
};
