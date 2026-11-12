/** Bounded retries and lease-conditional acknowledgements; a late provider answer cannot settle another claim. */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { atomicallyOn } from '../../platform/transactions';
import { PUSH_ATTEMPTS_MAX } from '../../platform/push-policy';
import { reschedulePush, type PushClaim } from './queue';

const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 900_000;

export type PushOutcome =
  | { readonly kind: 'delivered' | 'canceled' | 'refused'; readonly status?: number }
  | { readonly kind: 'held' }
  | { readonly kind: 'retry'; readonly status?: number; readonly retryAfter?: string };

/** Retry-After seconds or HTTP-date, bounded by the original expiry by the caller. */
export const pushRetryDelay = (
  attempts: number,
  retryAfter: string | undefined,
  now: Date,
): number => {
  const fallback = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
  if (retryAfter === undefined) return fallback;
  const requested = /^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1_000
    : Date.parse(retryAfter) - now.getTime();
  return Number.isFinite(requested)
    ? Math.max(fallback, Math.min(60 * 60_000, requested))
    : fallback;
};

export const settlePush = async (
  database: Executor,
  claim: PushClaim,
  outcome: PushOutcome,
  clock: Clock,
): Promise<void> => {
  await atomicallyOn(database)(async (tx) => {
    const parent = await tx
      .selectFrom('push_intents')
      .select('id')
      .where('id', '=', claim.intentId)
      .where('state', '=', 'admitted')
      .forUpdate()
      .executeTakeFirst();
    if (parent === undefined) return;
    const target = await tx
      .selectFrom('push_deliveries')
      .select(['attempts', 'next_attempt_at'])
      .where('intent_id', '=', claim.intentId)
      .where('subscription_id', '=', claim.subscriptionId)
      .where('generation', '=', claim.generation)
      .where('lease_id', '=', claim.leaseId)
      .where('state', '=', 'pending')
      .forUpdate()
      .executeTakeFirst();
    if (target === undefined) return;
    const now = clock.now();
    // Expired owners leave the row for recovery, even if nobody has replaced the lease yet.
    if (
      target.next_attempt_at.getTime() <= now.getTime() ||
      claim.expiresAt.getTime() <= now.getTime()
    )
      return;
    const state =
      outcome.kind === 'held' || outcome.kind === 'retry'
        ? target.attempts >= PUSH_ATTEMPTS_MAX || claim.expiresAt.getTime() <= now.getTime()
          ? 'exhausted'
          : 'pending'
        : outcome.kind;
    const delay =
      outcome.kind === 'retry' ? pushRetryDelay(target.attempts, outcome.retryAfter, now) : 60_000;
    await tx
      .updateTable('push_deliveries')
      .set({
        state,
        lease_id: null,
        next_attempt_at: new Date(Math.min(claim.expiresAt.getTime(), now.getTime() + delay)),
        last_status: 'status' in outcome ? (outcome.status ?? null) : null,
        last_failure: outcome.kind === 'retry' ? 'provider' : null,
      })
      .where('intent_id', '=', claim.intentId)
      .where('subscription_id', '=', claim.subscriptionId)
      .where('generation', '=', claim.generation)
      .where('lease_id', '=', claim.leaseId)
      .execute();
    await reschedulePush(tx, claim.intentId, now);
  });
};
