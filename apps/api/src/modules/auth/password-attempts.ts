/**
 * The throttle on guessing a password (D-179 §4): the library's `/sign-in/email` and
 * `/change-password`, the two routes left open that weigh one — every other route of the library's that
 * would (`/verify-password`, `/delete-user`) is closed (`better-auth.ts`, held by a test over its
 * endpoint table). Counted in the database (`counters.ts`), as the
 * sign-in links are, so a restart or a second process hands nothing back.
 *
 * - **Wrong guesses are what is counted.** An attempt is counted before the password is weighed — so
 *   attempts at once cannot all pass a count that has not moved yet — and given back when it was not a
 *   wrong guess: a sign-in that worked, a request the library refused for its shape. A successful
 *   sign-in spends nothing.
 * - **Ten for an address from one client, twenty from one client whatever the addresses, in fifteen
 *   minutes**; past either, `429 RATE_LIMITED` with `Retry-After`, and the password is not weighed.
 * - **Never a lockout of the account.** A count for the address alone — whoever sends it — would let a
 *   stranger spend the administrator's guesses from anywhere and keep them out with the right
 *   password. So the address is counted *with* the client: a stranger's wrong guesses use up the
 *   stranger's own allowance, never the administrator's from their own client.
 * - **A client is a network, not a host** (`limitKeyFor`): an IPv4 address, or an IPv6 /64 — one
 *   subscriber's allocation, whose host bits are theirs to rotate, so a key per IPv6 address would be a
 *   fresh budget per request. The cost of no lockout is that a guesser with many *networks* has ten an
 *   address from each; the policy (`@purlay/types` `passwordProblem`) and the hash's cost stand against
 *   that, and it is the residual risk D-179 §4 accepts.
 *
 * Keys name a purpose and digests, never an address: `purlay:password:address:<sha256(address)>:
 * client:<sha256(network)>` and `purlay:password:client:<sha256(network)>`. An erasure deletes the
 * address's counters by their prefix (`addressAttemptsPrefix`).
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { limitKeyFor } from '../../platform/client-key';
import { tokenDigest } from '../../platform/tokens';
import { counted, uncounted } from './counters';

/** Wrong passwords for one address from one client in a window. */
export const PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT = 10;
/** Wrong passwords from one client in a window, whatever the addresses. */
export const PASSWORD_FAILURES_PER_CLIENT = 20;
/** The window, opened by the first wrong guess. */
export const PASSWORD_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/** The prefix every counter of an address's attempts starts with: what an erasure deletes by. */
export const addressAttemptsPrefix = async (address: string): Promise<string> =>
  `purlay:password:address:${await tokenDigest(address)}:`;

/** An attempt counted, to be given back if it turns out not to have been a wrong guess. */
export interface Attempt {
  readonly keys: readonly string[];
}

/** An attempt refused by the throttle: how long until one more would be weighed. */
export interface Throttled {
  readonly retryAfterSeconds: number;
}

/**
 * One attempt at the password of `address` from `client`, counted now. Past either limit nothing is
 * kept counted for it and it is refused; otherwise it is the caller's to give back (`giveBack`) unless
 * the password turned out wrong.
 */
export const countAttempt = async (
  database: Executor,
  clock: Clock,
  address: string,
  client: string | undefined,
): Promise<Attempt | Throttled> => {
  const now = clock.now();
  // The network, never the host: an IPv6 /64, an IPv4 address; none, one shared bucket.
  const from = await tokenDigest(limitKeyFor(client));
  const pairKey = `${await addressAttemptsPrefix(address)}client:${from}`;
  const clientKey = `purlay:password:client:${from}`;
  const pair = await counted(database, pairKey, now, PASSWORD_FAILURE_WINDOW_MS);
  const fromClient = await counted(database, clientKey, now, PASSWORD_FAILURE_WINDOW_MS);
  const over = [
    ...(pair.count > PASSWORD_FAILURES_PER_ADDRESS_AND_CLIENT ? [pair.closes] : []),
    ...(fromClient.count > PASSWORD_FAILURES_PER_CLIENT ? [fromClient.closes] : []),
  ];
  const attempt: Attempt = { keys: [pairKey, clientKey] };
  if (over.length === 0) return attempt;
  // Refused, not weighed: no guess was made, so nothing stays counted for it.
  await giveBack(database, clock, attempt);
  const waitMs = Math.max(...over) - now.getTime();
  return { retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
};

/** The attempt was not a wrong guess: what it counted is given back. */
export const giveBack = async (
  database: Executor,
  clock: Clock,
  attempt: Attempt,
): Promise<void> => {
  const now = clock.now();
  for (const key of attempt.keys) await uncounted(database, key, now);
};
