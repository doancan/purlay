/** Session-owned APNs registration storage (D-342). */
import { sql, type Transaction } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { PUSH_PERSON_LOCK } from '../../platform/push-policy';
import { requireLiveSession } from '../auth/sessions';
import { normalizeApnsToken } from './apns';
import { PUSH_SUBSCRIPTIONS_MAX, type Subscriber } from './subscriptions';

const requireSubscriber = async (
  transaction: Transaction,
  clock: Clock,
  subscriber: Subscriber,
): Promise<void> => {
  const authority = await requireLiveSession(transaction, clock, subscriber.sessionId);
  if (authority.userId !== subscriber.userId)
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
};

const validToken = (deviceToken: string): string => {
  const token = normalizeApnsToken(deviceToken);
  if (token === undefined)
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'That device token is invalid.',
      details: { fields: { deviceToken: 'expected a hexadecimal APNs token' } },
    });
  return token;
};

export const registerApnsDevice = async (
  transaction: Transaction,
  clock: Clock,
  subscriber: Subscriber,
  deviceToken: string,
  providerScope: string,
): Promise<void> => {
  await requireSubscriber(transaction, clock, subscriber);
  const token = validToken(deviceToken);
  // As with capture and provider settlement, serialize the recipient before touching device rows.
  await sql`select pg_advisory_xact_lock(hashtextextended(${subscriber.userId}, ${PUSH_PERSON_LOCK}))`.execute(
    transaction,
  );
  const registeredAt = clock.now();
  try {
    await transaction
      .insertInto('apns_subscriptions')
      .values({
        session_id: subscriber.sessionId,
        device_token: token,
        provider_scope: providerScope,
        registered_at: registeredAt,
      })
      .onConflict((conflict) =>
        conflict.column('session_id').doUpdateSet({
          device_token: token,
          provider_scope: providerScope,
          registered_at: registeredAt,
          generation: sql`gen_random_uuid()`,
        }),
      )
      .execute();
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === '23505' &&
      'constraint' in error &&
      error.constraint === 'apns_subscriptions_device_token_key'
    ) {
      // PostgreSQL's unique-key detail contains the token.
      throw new AppError({
        code: 'VALIDATION_FAILED',
        message: 'That device cannot be registered.',
        details: { fields: { deviceToken: 'unavailable' } },
      });
    }
    throw error;
  }
  const count = await transaction
    .selectFrom('apns_subscriptions as s')
    .innerJoin('sessions as live', 'live.id', 's.session_id')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('live.user_id', '=', subscriber.userId)
    .where('live.expires_at', '>', registeredAt)
    .executeTakeFirstOrThrow();
  if (Number(count.n) > PUSH_SUBSCRIPTIONS_MAX)
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'Remove an existing iOS device before registering another one.',
      details: { fields: { deviceToken: 'device limit reached' } },
    });
};

export const removeApnsDevice = async (
  transaction: Transaction,
  clock: Clock,
  subscriber: Subscriber,
  deviceToken?: string,
): Promise<void> => {
  await requireSubscriber(transaction, clock, subscriber);
  const token = deviceToken === undefined ? undefined : validToken(deviceToken);
  await sql`select pg_advisory_xact_lock(hashtextextended(${subscriber.userId}, ${PUSH_PERSON_LOCK}))`.execute(
    transaction,
  );
  const own = transaction
    .deleteFrom('apns_subscriptions')
    .where('session_id', '=', subscriber.sessionId);
  await (token === undefined ? own : own.where('device_token', '=', token)).execute();
};
