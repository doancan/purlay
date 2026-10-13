/**
 * Web Push's doors (#78, D-126): the server's key, a device subscribing and leaving, and the
 * language a person is told in. Each is the caller's own — no workspace is named, and nothing about
 * anybody else is read or answered.
 */
import type { Executor } from '@purlay/db';
import {
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  SetLocaleRequest,
  type PushKeyResponse,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import {
  pushUnavailable,
  setLocale,
  subscribe,
  unsubscribe,
} from '../../modules/push/subscriptions';
import { atomicallyOn } from '../../platform/transactions';
import { requireSession } from './session';
import { validated } from './validate';

export interface PushDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly config: Pick<Config, 'VAPID_PUBLIC_KEY'>;
}

/** The key, or push is off: what every door but the language's needs first. */
const serverKey = (config: PushDependencies['config']): string => {
  if (config.VAPID_PUBLIC_KEY === undefined) throw pushUnavailable();
  return config.VAPID_PUBLIC_KEY;
};

/** `GET /api/push/key` — what a browser subscribes with. */
export const readPushKey = async (
  { database, clock, config }: PushDependencies,
  request: Request,
): Promise<PushKeyResponse> => {
  await requireSession(database, clock, request);
  return { publicKey: serverKey(config) };
};

/** `POST /api/push/subscriptions` — this device, in this session, is told. */
export const subscribeDevice = async (
  { database, clock, config }: PushDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  const subscriber = await requireSession(database, clock, request);
  const key = serverKey(config);
  const input = validated(PushSubscribeRequest, body);
  await atomicallyOn(database)(async (transaction) => {
    await subscribe(transaction, clock, subscriber, input, key);
  });
};

/** `POST /api/push/subscriptions/remove` — this device stops being told. */
export const unsubscribeDevice = async (
  { database, clock }: PushDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  const { userId } = await requireSession(database, clock, request);
  await unsubscribe(database, userId, validated(PushUnsubscribeRequest, body).endpoint);
};

/** `PUT /api/me/locale` — the language the server writes this person's notifications in (D-41). */
export const setMyLocale = async (
  { database, clock }: PushDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  const { userId } = await requireSession(database, clock, request);
  await setLocale(database, userId, validated(SetLocaleRequest, body).locale);
};
