/** Expiry and diagnostic receipts are bounded indexed batches, including when all product modules are off. */
import type { Executor } from '@purlay/db';
import type { Logger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import type { FailureCount } from './failures';
import { retirePushIntents } from './retire';

const SWEEP_BATCH_MAX = 500;

export const maintainPushes = async (
  database: Executor,
  now: Date,
  log: Logger,
  failed: FailureCount,
  sweep = true,
): Promise<boolean> => {
  const { reports, more } = await atomicallyOn(database)(async (tx) => {
    const expired = sweep
      ? await tx
          .selectFrom('push_intents')
          .select(['id', 'module', 'state'])
          .where('expires_at', '<=', now)
          .orderBy('expires_at')
          .orderBy('id')
          .limit(SWEEP_BATCH_MAX)
          .forUpdate()
          .skipLocked()
          .execute()
      : [];
    const retired = new Set(
      await retirePushIntents(
        tx,
        expired.map((row) => row.id),
      ),
    );
    const terminal = await tx
      .selectFrom('push_intents')
      .select(['id', 'module', 'state'])
      .where('state', 'in', ['overflow', 'throttled'])
      .where('reported_at', 'is', null)
      .orderBy('id')
      .limit(SWEEP_BATCH_MAX)
      .forUpdate()
      .skipLocked()
      .execute();
    if (terminal.length > 0)
      await tx
        .updateTable('push_intents')
        .set({ reported_at: now })
        .where(
          'id',
          'in',
          terminal.map((row) => row.id),
        )
        .execute();
    const budgets = sweep
      ? await tx
          .selectFrom('push_notice_budgets as b')
          .select(['b.user_id', 'b.module', 'b.kind'])
          .where('b.updated_at', '<', new Date(now.getTime() - 86_400_000))
          .where((eb) =>
            eb.not(
              eb.exists(
                eb
                  .selectFrom('push_intents as p')
                  .select('p.id')
                  .whereRef('p.user_id', '=', 'b.user_id')
                  .whereRef('p.module', '=', 'b.module')
                  .whereRef('p.kind', '=', 'b.kind')
                  .where('p.state', 'in', ['pending', 'admitted'])
                  .where('p.expires_at', '>', now),
              ),
            ),
          )
          .orderBy('b.updated_at')
          .limit(SWEEP_BATCH_MAX)
          .forUpdate()
          .skipLocked()
          .execute()
      : [];
    for (const budget of budgets)
      await tx
        .deleteFrom('push_notice_budgets')
        .where('user_id', '=', budget.user_id)
        .where('module', '=', budget.module)
        .where('kind', '=', budget.kind)
        .execute();
    return {
      reports: [
        ...terminal,
        ...expired.filter(
          (row) => (row.state === 'pending' || row.state === 'admitted') && retired.has(row.id),
        ),
      ],
      // A completely busy batch waits for the next sweep rather than spinning a zero-delay pump.
      more:
        (expired.length === SWEEP_BATCH_MAX && retired.size > 0) ||
        terminal.length === SWEEP_BATCH_MAX ||
        budgets.length === SWEEP_BATCH_MAX,
    };
  });
  const counts = new Map<string, { module: string; state: string; n: number }>();
  for (const report of reports) {
    const key = JSON.stringify([report.module, report.state]);
    const current = counts.get(key);
    counts.set(key, { ...report, n: (current?.n ?? 0) + 1 });
  }
  for (const report of counts.values()) {
    failed(report.state === 'throttled' ? 'throttled' : 'dropped', report.n, report.module);
    if (report.state !== 'throttled')
      log.info('pending pushes retired', {
        reason: report.state === 'overflow' ? 'overflow' : 'expired',
        module: report.module,
        dropped: report.n,
      });
  }
  return more;
};
