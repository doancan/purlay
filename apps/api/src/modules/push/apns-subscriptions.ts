/** Session-owned APNs registration storage (D-342). */
import { sql, type Transaction } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireLiveSession } from '../auth/sessions';
import { normalizeApnsToken } from './apns';
import type { Subscriber } from './subscriptions';

const tokenForSession = async (
  transaction: Transaction,
  clock: Clock,
  subscriber: Subscriber,
  deviceToken: string,
): Promise<string> => {
  const authority = await requireLiveSession(transaction, clock, subscriber.sessionId);
  if (authority.userId !== subscriber.userId)
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
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
): Promise<void> => {
  const token = await tokenForSession(transaction, clock, subscriber, deviceToken);
  const registeredAt = clock.now();
  try {
    await transaction
      .insertInto('apns_subscriptions')
      .values({
        session_id: subscriber.sessionId,
        device_token: token,
        registered_at: registeredAt,
      })
      .onConflict((conflict) =>
        conflict.column('session_id').doUpdateSet({
          device_token: token,
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
};

export const removeApnsDevice = async (
  transaction: Transaction,
  clock: Clock,
  subscriber: Subscriber,
  deviceToken: string,
): Promise<void> => {
  const token = await tokenForSession(transaction, clock, subscriber, deviceToken);
  await transaction
    .deleteFrom('apns_subscriptions')
    .where('session_id', '=', subscriber.sessionId)
    .where('device_token', '=', token)
    .execute();
};
