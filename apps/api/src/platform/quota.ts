/**
 * Daily allowances kept in the database, beside the sign-in counters (`modules/auth/magic-link.ts`):
 * `rate_limits` rows, so a restart or a second process hands nothing back (D-179, Q9).
 *
 * - **Taken together or not at all.** An action that spends from two allowances — an inviter's and a
 *   workspace's — takes the most both have room for, and writes both: a refusal by one never spends the
 *   other, and neither is spent past its limit however many requests come at once. The keys are locked
 *   (transaction-scoped advisory locks, in sorted order, so two requests cannot wait on each other)
 *   before they are read, and the locks go when the caller's transaction ends — which is why a
 *   transaction is asked for: an allowance spent by a request that then fails is given back.
 * - **A day opens at the first spend and closes a day later**, as the sign-in hour does: `last_request`
 *   holds when the window closes, so the library's own pruning of the table, which goes by that column,
 *   never takes a window that is still open, and `sweep:email-sign-ins` removes it a day after it closed.
 * - **Keys name a purpose and an id, never an address.**
 */
import { sql, type Transaction } from '@purlay/db';
import { DAY_MS } from './clock';

export interface Allowance {
  /** What the counter is kept under in `rate_limits`. */
  readonly key: string;
  /** How many may be spent in a day under it. */
  readonly limit: number;
}

export interface Taken {
  /** How many of those asked for were taken: between none and all. */
  readonly granted: number;
  /** The allowance that left less than was asked for, when `granted` is short of it. */
  readonly refusedBy: Allowance | undefined;
}

const spentIn = async (
  transaction: Transaction,
  key: string,
  at: number,
): Promise<{ readonly count: number; readonly closes: number | undefined }> => {
  const { rows } = await sql<{ count: number; last_request: string }>`
    select count, last_request from rate_limits where key = ${key}
  `.execute(transaction);
  const row = rows[0];
  // A window that closed is over: what it counted is spent no longer.
  if (row === undefined || Number(row.last_request) <= at) return { count: 0, closes: undefined };
  return { count: row.count, closes: Number(row.last_request) };
};

/** Takes up to `wanted` from every allowance in `allowances`, at `now`. */
export const takeDaily = async (
  transaction: Transaction,
  now: Date,
  allowances: readonly Allowance[],
  wanted: number,
): Promise<Taken> => {
  const at = now.getTime();
  const sorted = [...allowances].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { key } of sorted) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(transaction);
  }
  const states = await Promise.all(
    allowances.map(async (allowance) => ({
      allowance,
      ...(await spentIn(transaction, allowance.key, at)),
    })),
  );
  let granted = wanted;
  let refusedBy: Allowance | undefined;
  for (const state of states) {
    const room = Math.max(0, state.allowance.limit - state.count);
    if (room < granted) {
      granted = room;
      refusedBy = state.allowance;
    }
  }
  if (granted > 0) {
    for (const state of states) {
      const closes = String(state.closes ?? at + DAY_MS);
      await sql`
        insert into rate_limits (key, count, last_request)
        values (${state.allowance.key}, ${state.count + granted}, ${closes})
        on conflict (key) do update set count = excluded.count, last_request = excluded.last_request
      `.execute(transaction);
    }
  }
  return { granted, refusedBy: granted < wanted ? refusedBy : undefined };
};
