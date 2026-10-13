/**
 * A person's devices that are told of what needs them while Purlay is closed (#78, D-126).
 *
 * A subscription is a browser's: the push service's endpoint and the keys it gave for encrypting to
 * it. It belongs to the session it was made in — signing out ends it, and a push needs the session
 * live — and to the application-server key it was made with, so a key the operator replaced leaves
 * it inert rather than failing for ever.
 */
import type { Executor } from '@purlay/db';
import type { PushLocale, PushSubscribeRequest } from '@purlay/types';
import { AppError } from '../../platform/errors';

/** Devices a person keeps told; past it the oldest goes. Browsers, not a log of them. */
export const PUSH_SUBSCRIPTIONS_MAX = 20;

/** The person subscribing, and the session they did it in. */
export interface Subscriber {
  readonly userId: string;
  readonly sessionId: string;
}

/** Push switched off by the operator: no keys (`VAPID_*`). */
export const pushUnavailable = (): AppError =>
  new AppError({
    code: 'PUSH_UNAVAILABLE',
    message: 'Notifications to devices are not switched on for this server.',
  });

/**
 * The browser's public key is a point on P-256, or the push could never be encrypted for it: found
 * here, at the door, rather than inside a delivery nobody waits on.
 */
const isPoint = async (p256dh: string): Promise<boolean> => {
  try {
    await crypto.subtle.importKey(
      'raw',
      Buffer.from(p256dh, 'base64url'),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    );
    return true;
  } catch {
    // A refusal to import is the answer to the question asked, not an error to report.
    return false;
  }
};

/**
 * Keeps this device told: one row per endpoint (a browser signed into another account moves it),
 * the person's language with it, and no more than `PUSH_SUBSCRIPTIONS_MAX` devices, oldest dropped.
 */
export const subscribe = async (
  executor: Executor,
  subscriber: Subscriber,
  input: PushSubscribeRequest,
  serverKey: string,
): Promise<void> => {
  if (!(await isPoint(input.keys.p256dh))) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'That subscription cannot be encrypted for.',
      details: { fields: { 'keys/p256dh': 'not a P-256 public key' } },
    });
  }
  await executor
    .insertInto('push_subscriptions')
    .values({
      user_id: subscriber.userId,
      session_id: subscriber.sessionId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      server_key: serverKey,
    })
    .onConflict((conflict) =>
      conflict.column('endpoint').doUpdateSet({
        user_id: subscriber.userId,
        session_id: subscriber.sessionId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        server_key: serverKey,
        failures: 0,
      }),
    )
    .execute();
  const kept = await executor
    .selectFrom('push_subscriptions')
    .select('id')
    .where('user_id', '=', subscriber.userId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(PUSH_SUBSCRIPTIONS_MAX)
    .execute();
  await executor
    .deleteFrom('push_subscriptions')
    .where('user_id', '=', subscriber.userId)
    .where(
      'id',
      'not in',
      kept.map((row) => row.id),
    )
    .execute();
  await setLocale(executor, subscriber.userId, input.locale);
};

/**
 * This device stops being told. Only the caller's own row: an endpoint somebody else holds is the
 * same answer and stays theirs, so the call says nothing about who else is subscribed.
 */
export const unsubscribe = async (
  executor: Executor,
  userId: string,
  endpoint: string,
): Promise<void> => {
  await executor
    .deleteFrom('push_subscriptions')
    .where('user_id', '=', userId)
    .where('endpoint', '=', endpoint)
    .execute();
};

/** The language this person's notifications are written in (D-41). */
export const setLocale = async (
  executor: Executor,
  userId: string,
  locale: PushLocale,
): Promise<void> => {
  await executor.updateTable('users').set({ locale }).where('id', '=', userId).execute();
};

/** Devices made in sessions that just ended: signing out stops them being told. */
export const forgetSessions = async (
  executor: Executor,
  sessionIds: readonly string[],
): Promise<void> => {
  if (sessionIds.length === 0) return;
  await executor.deleteFrom('push_subscriptions').where('session_id', 'in', sessionIds).execute();
};
