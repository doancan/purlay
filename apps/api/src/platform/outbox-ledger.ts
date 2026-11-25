/**
 * The ledger of deliveries (#1305, D-335): which fact was delivered to which consumer, and when, kept after the outbox's own row is
 * swept, so an operator can prove a delivery after the transient table has forgotten it. Opt-in (`OUTBOX_LEDGER_DAYS`); ids, the type
 * and the time only, never a payload. This file names the table beside `outbox-drain.ts` (which writes it in the transaction that marks
 * a row delivered) and `outbox-sweep.ts` (which takes what is past its retention).
 */
import { sql, type Executor } from '@purlay/db';
import { DAY_MS, type Clock } from './clock';

/** One recorded delivery, as the operator reads it. */
export interface LedgerEntry {
  readonly factId: string;
  readonly type: string;
  readonly producer: string;
  readonly consumer: string;
  readonly deliveredAt: Date;
}

/** The most a read returns: a workspace's deliveries are many, and the operator narrows by fact or consumer. */
export const LEDGER_READ_MAX = 200;

/** A workspace's deliveries, newest first, narrowed by fact or consumer; at most `limit`, never past `LEDGER_READ_MAX`. */
export const readLedger = async (
  executor: Executor,
  workspaceId: string,
  filters: { readonly factId?: string; readonly consumer?: string; readonly limit?: number },
): Promise<readonly LedgerEntry[]> => {
  let query = executor
    .selectFrom('outbox_ledger')
    .select(['fact_id', 'type', 'producer', 'consumer', 'delivered_at'])
    .where('workspace_id', '=', workspaceId);
  if (filters.factId !== undefined) query = query.where('fact_id', '=', filters.factId);
  if (filters.consumer !== undefined) query = query.where('consumer', '=', filters.consumer);
  const rows = await query
    .orderBy('delivered_at', 'desc')
    .orderBy('fact_id', 'desc')
    .limit(Math.min(filters.limit ?? LEDGER_READ_MAX, LEDGER_READ_MAX))
    .execute();
  return rows.map((row) => ({
    factId: row.fact_id,
    type: row.type,
    producer: row.producer,
    consumer: row.consumer,
    deliveredAt: row.delivered_at,
  }));
};

/** Rows of the ledger a sweep takes in one statement. */
const LEDGER_SWEEP_BATCH = 5_000;

/**
 * What the sweep takes of the ledger: the deliveries older than `keptDays`, oldest first, in batches of one statement each, until one
 * comes back short. With no retention (`OUTBOX_LEDGER_DAYS` unset) it takes nothing: turning the ledger off stops the writes and
 * keeps what is there, for the day it is turned on again or the operator drops it. Says how many it took.
 */
export const sweepLedger = async (dependencies: {
  readonly database: Executor;
  readonly clock: Clock;
  readonly keptDays: number | undefined;
}): Promise<number> => {
  const { database, clock, keptDays } = dependencies;
  if (keptDays === undefined) return 0;
  const before = new Date(clock.now().getTime() - keptDays * DAY_MS);
  let removed = 0;
  for (;;) {
    // One statement a batch, the oldest first; the key is two columns, so the rows are named by the pair.
    const gone = await sql`
      delete from outbox_ledger
      where (fact_id, consumer) in (
        select fact_id, consumer from outbox_ledger
        where delivered_at < ${before}
        order by delivered_at
        limit ${LEDGER_SWEEP_BATCH}
      )`.execute(database);
    const count = Number(gone.numAffectedRows ?? 0n);
    removed += count;
    if (count < LEDGER_SWEEP_BATCH) return removed;
  }
};
