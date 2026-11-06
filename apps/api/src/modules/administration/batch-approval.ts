import type { Executor } from '@purlay/db';
import type { ServerBatchApprovalResponse } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import { AppError } from '../../platform/errors';
import type { ServerAdminSession } from '../setup/setup';
import { decideAdmission } from './admission';

/** Each confirmed target is independent, and its current pending state is checked under the account lock. */
export const approvePendingAccounts = async (
  db: Executor,
  clock: Clock,
  log: Logger,
  userIds: readonly string[],
  authorize: () => Promise<ServerAdminSession>,
  signal?: AbortSignal,
): Promise<ServerBatchApprovalResponse> => {
  const results: ServerBatchApprovalResponse['results'] = [];
  let stopped = false;
  for (const userId of userIds) {
    if (stopped || signal?.aborted) {
      results.push({ userId, outcome: 'not_processed' });
      continue;
    }
    try {
      const admin = await authorize();
      if (signal?.aborted) {
        results.push({ userId, outcome: 'not_processed' });
        stopped = true;
        continue;
      }
      await atomicallyOn(db)(async (tx) => {
        await decideAdmission(tx, clock, admin, userId, 'approved', true);
      });
      results.push({ userId, outcome: 'approved' });
    } catch (failure) {
      if (
        failure instanceof AppError &&
        (failure.body.code === 'FORBIDDEN' ||
          failure.body.code === 'USER_NOT_FOUND' ||
          failure.body.code === 'ROUTE_NOT_FOUND')
      ) {
        results.push({ userId, outcome: 'refused' });
        if (failure.body.code === 'ROUTE_NOT_FOUND') stopped = true;
      } else {
        log.error('account approval result could not be confirmed', { userId, err: failure });
        results.push({ userId, outcome: 'unconfirmed' });
        stopped = true;
      }
    }
  }
  return { results };
};
