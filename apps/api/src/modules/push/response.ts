/** Apply a provider answer under the same recipient lock which serializes claims, capture and erasure. No I/O inside. */
import { sql, type Executor, type Transaction } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { PUSH_PERSON_LOCK } from '../../platform/push-policy';
import { atomicallyOn } from '../../platform/transactions';
import type { Device } from './devices';
import { ownsPushClaim, type PushClaim } from './queue';

export const applyPushResponse = async (
  database: Executor,
  clock: Clock,
  claim: PushClaim,
  device: Device,
  change: (tx: Transaction) => Promise<void>,
): Promise<boolean> =>
  await atomicallyOn(database)(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${claim.userId}, ${PUSH_PERSON_LOCK}))`.execute(
      tx,
    );
    // Never wait on a subscription while holding a queue row: logout cascades in the opposite direction.
    const subscription = await tx
      .selectFrom('push_subscriptions')
      .select('id')
      .where('id', '=', device.id)
      .where('user_id', '=', device.userId)
      .where('session_id', '=', device.sessionId)
      .where('generation', '=', device.generation)
      .forUpdate()
      .executeTakeFirst();
    if (subscription === undefined) return false;
    const target = await tx
      .selectFrom('push_deliveries')
      .select('intent_id')
      .where('intent_id', '=', claim.intentId)
      .where('subscription_id', '=', claim.subscriptionId)
      .where('generation', '=', claim.generation)
      .where('lease_id', '=', claim.leaseId)
      .where('state', '=', 'pending')
      .forUpdate()
      .executeTakeFirst();
    if (target === undefined || !(await ownsPushClaim(tx, claim, clock.now(), device.serverKey)))
      return false;
    await change(tx);
    return true;
  });
