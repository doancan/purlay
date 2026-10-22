/**
 * The sign-in counters of ours (D-138 §7, D-179 §4): `rate_limits` rows beside the library's, so a
 * restart or a second process hands nothing back (D-179, Q9). One mechanism for every count a sign-in
 * keeps — the links an address is sent (`magic-link.ts`) and the passwords a client gets wrong
 * (`password-attempts.ts`).
 *
 * A window opens at the first count and `last_request` holds when it **closes** — not, as in the
 * library's own rows, when the last request came. The library prunes the table by that column against
 * the longest window it knows of, which is shorter than ours: a row it may prune is one whose window is
 * over, and nothing is handed back early. Keys name a purpose and a digest, never an address.
 */
import { sql, type Executor } from '@purlay/db';

/** What a count came to: how many in the window, and when the window closes (epoch ms). */
export interface Count {
  readonly count: number;
  readonly closes: number;
}

/**
 * One more under `key` in a window of `windowMs`, and how many that makes. One statement: the row is
 * taken on conflict, so counts at once are made one after another and none sees a stale number.
 */
export const counted = async (
  executor: Executor,
  key: string,
  now: Date,
  windowMs: number,
): Promise<Count> => {
  const at = now.getTime();
  const closes = String(at + windowMs);
  const { rows } = await sql<{ count: number; last_request: string }>`
    insert into rate_limits (key, count, last_request) values (${key}, 1, ${closes})
    on conflict (key) do update set
      count = case when rate_limits.last_request <= ${String(at)} then 1 else rate_limits.count + 1 end,
      last_request = case when rate_limits.last_request <= ${String(at)} then excluded.last_request
                          else rate_limits.last_request end
    returning count, last_request
  `.execute(executor);
  const row = rows[0];
  // No row back from an upsert is not a count of zero: refused, as for a count past any limit.
  if (row === undefined) return { count: Number.POSITIVE_INFINITY, closes: at + windowMs };
  return { count: row.count, closes: Number(row.last_request) };
};

/** One given back under `key`, while its window is open: never below none, never into a new window. */
export const uncounted = async (executor: Executor, key: string, now: Date): Promise<void> => {
  await sql`
    update rate_limits set count = greatest(count - 1, 0)
    where key = ${key} and last_request > ${String(now.getTime())}
  `.execute(executor);
};
