/**
 * Web Push's doors (#78, D-126): the server's key, a device subscribing and leaving, and the
 * language a person is told in. Each is the caller's own — no workspace is named, and nothing about
 * anybody else is read or answered.
 */
import type { Auth } from '../../modules/auth/better-auth';
import type { Executor } from '@purlay/db';
import {
  PushSubscribeRequest,
  PushUnsubscribeRequest,
  SetLocaleRequest,
  type PushKeyResponse,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { PushConfiguration } from '../../modules/push/settings';
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
  /** Who is calling: every session is resolved through it (`sessions.ts`, D-179). */
  readonly auth: Auth;
  readonly database: Executor;
  readonly clock: Clock;
  readonly pushConfiguration: Pick<PushConfiguration, 'keys'>;
}

/** `GET /api/push/key` — what a browser subscribes with. */
export const readPushKey = async (
  { auth, pushConfiguration }: PushDependencies,
  request: Request,
): Promise<PushKeyResponse> => {
  await requireSession(auth, request);
  return { publicKey: (await pushConfiguration.keys())?.publicKey ?? null };
};

/** `POST /api/push/subscriptions` — this device, in this session, is told. */
export const subscribeDevice = async (
  { auth, database, clock, pushConfiguration }: PushDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  const subscriber = await requireSession(auth, request);
  const key = (await pushConfiguration.keys())?.publicKey;
  if (key === undefined) throw pushUnavailable();
  const input = validated(PushSubscribeRequest, body);
  await atomicallyOn(database)(async (transaction) => {
    await subscribe(transaction, clock, subscriber, input, key);
  });
};

/** `POST /api/push/subscriptions/remove` — this device stops being told. */
export const unsubscribeDevice = async (
  { auth, database }: PushDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  const { userId } = await requireSession(auth, request);
  await unsubscribe(database, userId, validated(PushUnsubscribeRequest, body).endpoint);
};

/** `PUT /api/me/locale` — the language the server writes this person's notifications in (D-41). */
export const setMyLocale = async (
  { auth, database }: PushDependencies,
  request: Request,
  body: unknown,
): Promise<void> => {
  const { userId } = await requireSession(auth, request);
  await setLocale(database, userId, validated(SetLocaleRequest, body).locale);
};
