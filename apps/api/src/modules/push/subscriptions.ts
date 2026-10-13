/**
 * A person's devices that are told of what needs them while Purlay is closed (#78, D-126).
 *
 * A subscription is a browser's: the push service's endpoint and the keys it gave for encrypting to
 * it. It belongs to the session it was made in — signing out ends it, and a push needs the session
 * live — and to the application-server key it was made with, so a key the operator replaced leaves
 * it inert rather than failing for ever.
 */
import type { Executor, Transaction } from '@purlay/db';
import type { PushLocale, PushSubscribeRequest } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { requireLiveSession } from '../auth/sessions';
import { externalImageAddress } from '../images/proxy';

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
  } catch (error) {
    // Refused as key data is the answer to the question asked; anything else is the runtime's
    // failure, and must not read as the browser's.
    if (error instanceof DOMException && error.name === 'DataError') return false;
    throw error;
  }
};

/**
 * Keeps this device told: one row per endpoint, the person's language with it, and no more than
 * `PUSH_SUBSCRIPTIONS_MAX` devices, the least recently subscribed dropped.
 *
 * A browser signed into another account sends the same endpoint *and the same keys*, and moves
 * the row; the endpoint alone does not, so knowing somebody's address is not enough to silence
 * their device. Either way the answer is the same. Inside the transaction that holds the session
 * live (D-85): a sign-out that raced it either sees the row and deletes it, or refuses it.
 */
export const subscribe = async (
  transaction: Transaction,
  clock: Clock,
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
  // The rule a push is sent under (`sender.ts`), at the door: an address it could never reach is
  // refused here rather than stored and dropped by a delivery nobody waits on.
  if (externalImageAddress(input.endpoint) === null) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'That subscription cannot be sent to.',
      details: { fields: { endpoint: 'not an address a push may be sent to' } },
    });
  }
  await requireLiveSession(transaction, clock, subscriber.sessionId);
  const now = clock.now();
  await transaction
    .insertInto('push_subscriptions')
    .values({
      user_id: subscriber.userId,
      session_id: subscriber.sessionId,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      server_key: serverKey,
      created_at: now,
    })
    .onConflict((conflict) =>
      conflict
        .column('endpoint')
        .doUpdateSet({
          user_id: subscriber.userId,
          session_id: subscriber.sessionId,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          server_key: serverKey,
          created_at: now,
          failures: 0,
        })
        .where((row) =>
          row.or([
            row('push_subscriptions.user_id', '=', subscriber.userId),
            row.and([
              row('push_subscriptions.p256dh', '=', input.keys.p256dh),
              row('push_subscriptions.auth', '=', input.keys.auth),
            ]),
          ]),
        ),
    )
    .execute();
  const kept = await transaction
    .selectFrom('push_subscriptions')
    .select('id')
    .where('user_id', '=', subscriber.userId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(PUSH_SUBSCRIPTIONS_MAX)
    .execute();
  // Under the bound there is nothing to drop — and none at all is a person this endpoint did not
  // move to, for whom `not in ()` would not be SQL.
  if (kept.length === PUSH_SUBSCRIPTIONS_MAX) {
    await transaction
      .deleteFrom('push_subscriptions')
      .where('user_id', '=', subscriber.userId)
      .where(
        'id',
        'not in',
        kept.map((row) => row.id),
      )
      .execute();
  }
  await setLocale(transaction, subscriber.userId, input.locale);
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
