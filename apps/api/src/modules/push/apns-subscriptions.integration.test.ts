import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  type ClonedDatabase,
  type DB,
  type Selectable,
} from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { NOW } from '../../testing/doubles';
import { aSignedInUser } from '../../testing/signed-in';
import { revokeSession } from '../auth/sessions';
import { registerApnsDevice, removeApnsDevice } from './apns-subscriptions';
import type { Subscriber } from './subscriptions';

const clock = fixedClock(NOW);
let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const register = (subscriber: Subscriber, token: string): Promise<void> =>
  cloned.db
    .transaction()
    .execute((transaction) => registerApnsDevice(transaction, clock, subscriber, token));

const remove = (subscriber: Subscriber, token: string): Promise<void> =>
  cloned.db
    .transaction()
    .execute((transaction) => removeApnsDevice(transaction, clock, subscriber, token));

const registration = async (
  sessionId: string,
): Promise<Selectable<DB['apns_subscriptions']> | undefined> =>
  await cloned.db
    .selectFrom('apns_subscriptions')
    .selectAll()
    .where('session_id', '=', sessionId)
    .executeTakeFirst();

describe('integration: APNs registration storage', () => {
  test('refresh and rotation belong to the session and stale removal leaves the replacement alone', async () => {
    const owner = await aSignedInUser(cloned.db, clock, 'apns-owner');
    await register(owner, 'Aa1011');
    const first = await registration(owner.sessionId);
    expect(first).toMatchObject({ device_token: 'aa1011', registered_at: NOW });

    await register(owner, 'aa1011');
    expect((await registration(owner.sessionId))?.generation).not.toBe(first?.generation);
    await register(owner, 'bb1011');
    await remove(owner, 'aa1011');
    expect((await registration(owner.sessionId))?.device_token).toBe('bb1011');
    await remove(owner, 'BB1011');
    expect(await registration(owner.sessionId)).toBeUndefined();
  });

  test('a different live session cannot claim or remove a registered token', async () => {
    const owner = await aSignedInUser(cloned.db, clock, 'apns-first');
    const other = await aSignedInUser(cloned.db, clock, 'apns-second');
    await register(owner, 'aa2020');
    await register(other, 'bb2020');

    expect(await register(other, 'AA2020').catch((error: unknown) => error)).toMatchObject({
      body: { code: 'VALIDATION_FAILED', message: 'That device cannot be registered.' },
    });
    await remove(other, 'aa2020');
    expect((await registration(other.sessionId))?.device_token).toBe('bb2020');
    expect((await registration(owner.sessionId))?.device_token).toBe('aa2020');
  });

  test('sign-out removes the registration and releases the token for another session', async () => {
    const owner = await aSignedInUser(cloned.db, clock, 'apns-ending');
    const next = await aSignedInUser(cloned.db, clock, 'apns-next');
    await register(owner, 'aa3030');
    await revokeSession(cloned.db, owner.sessionId);
    expect(await registration(owner.sessionId)).toBeUndefined();
    expect(await register(owner, 'aa3030').catch((error: unknown) => error)).toMatchObject({
      body: { code: 'UNAUTHENTICATED' },
    });
    await register(next, 'aa3030');
    expect((await registration(next.sessionId))?.device_token).toBe('aa3030');
  });

  test('a mismatched user and malformed device tokens cannot register', async () => {
    const owner = await aSignedInUser(cloned.db, clock, 'apns-real');
    const other = await aSignedInUser(cloned.db, clock, 'apns-wrong-user');
    expect(
      await register({ ...owner, userId: other.userId }, 'aa4040').catch((error: unknown) => error),
    ).toMatchObject({
      body: { code: 'UNAUTHENTICATED' },
    });
    expect(await register(owner, 'aa4040/ff').catch((error: unknown) => error)).toMatchObject({
      body: { code: 'VALIDATION_FAILED' },
    });
    expect(await registration(owner.sessionId)).toBeUndefined();
    const longestToken = '40'.repeat(256);
    await register(owner, longestToken);
    expect(
      await register(owner, `${longestToken}40`).catch((error: unknown) => error),
    ).toMatchObject({
      body: { code: 'VALIDATION_FAILED' },
    });
    expect((await registration(owner.sessionId))?.device_token).toBe(longestToken);
  });
});
