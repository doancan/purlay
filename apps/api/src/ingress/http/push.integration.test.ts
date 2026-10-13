/**
 * A device's push subscription through the HTTP surface (#78, D-126): the server's key, subscribing
 * and its bounds, removing only one's own, the language a person is told in, and signing out.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { PushKeyResponse } from '@purlay/types';
import { createApp } from './app';
import { NOW, testConfig, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { PUSH_SUBSCRIPTIONS_MAX } from '../../modules/push/subscriptions';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

/** A real key pair's public half and a browser's real keys, so imports succeed. */
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
]);
const SERVER_PUBLIC = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString(
  'base64url',
);
const SERVER_PRIVATE = (await crypto.subtle.exportKey('jwk', pair.privateKey)).d ?? '';
const browser = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
  'deriveBits',
]);
const P256DH = Buffer.from(await crypto.subtle.exportKey('raw', browser.publicKey)).toString(
  'base64url',
);
const AUTH = Buffer.alloc(16, 7).toString('base64url');

const withKeys = testConfig({
  VAPID_PUBLIC_KEY: SERVER_PUBLIC,
  VAPID_PRIVATE_KEY: SERVER_PRIVATE,
  VAPID_SUBJECT: 'mailto:ops@purlay.test',
});

const call = async (
  db: Executor,
  method: string,
  path: string,
  as: SignedInUser | undefined,
  body?: unknown,
  config = withKeys,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock, config })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        ...(as === undefined ? {} : { cookie: as.cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const device = (n: number, locale: 'en' | 'tr' = 'en'): unknown => ({
  endpoint: `https://push.example.com/send/${String(n)}`,
  keys: { p256dh: P256DH, auth: AUTH },
  locale,
});

const rows = async (db: Executor, userId: string): Promise<string[]> =>
  (
    await db
      .selectFrom('push_subscriptions')
      .select('endpoint')
      .where('user_id', '=', userId)
      .orderBy('created_at')
      .orderBy('endpoint')
      .execute()
  ).map((row) => row.endpoint);

describe('integration: the server’s push key', () => {
  test('is given to a signed-in person, and is 503 PUSH_UNAVAILABLE where push is off', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'push-key');
      const key = await call(db, 'GET', '/api/push/key', alice);
      expect(key.status).toBe(200);
      const body: unknown = await key.json();
      expect(Value.Check(PushKeyResponse, body)).toBe(true);
      expect(body).toEqual({ publicKey: SERVER_PUBLIC });
      const off = await call(db, 'GET', '/api/push/key', alice, undefined, testConfig());
      expect(off.status).toBe(503);
      expect(await off.json()).toMatchObject({ error: { code: 'PUSH_UNAVAILABLE' } });
      expect((await call(db, 'GET', '/api/push/key', undefined)).status).toBe(401);
    });
  });
});

describe('integration: subscribing a device', () => {
  test('stores it for the person and their session, once however often it is sent, in their language', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'push-sub');
      expect((await call(db, 'POST', '/api/push/subscriptions', alice, device(1))).status).toBe(
        204,
      );
      expect(
        (await call(db, 'POST', '/api/push/subscriptions', alice, device(1, 'tr'))).status,
      ).toBe(204);
      expect(await rows(db, alice.userId)).toEqual(['https://push.example.com/send/1']);
      const stored = await db
        .selectFrom('push_subscriptions')
        .innerJoin('users', 'users.id', 'push_subscriptions.user_id')
        .select(['session_id', 'server_key', 'users.locale'])
        .where('user_id', '=', alice.userId)
        .executeTakeFirstOrThrow();
      expect(stored).toEqual({
        session_id: alice.sessionId,
        server_key: SERVER_PUBLIC,
        locale: 'tr',
      });
    });
  });

  test('an endpoint another person holds moves to the one subscribing it', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'push-move-a');
      const bob = await aSignedInUser(db, clock, 'push-move-b');
      await call(db, 'POST', '/api/push/subscriptions', alice, device(2));
      await call(db, 'POST', '/api/push/subscriptions', bob, device(2));
      expect(await rows(db, alice.userId)).toEqual([]);
      expect(await rows(db, bob.userId)).toEqual(['https://push.example.com/send/2']);
    });
  });

  test(`keeps at most ${String(PUSH_SUBSCRIPTIONS_MAX)} devices a person, dropping the oldest`, async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'push-bound');
      for (let n = 1; n <= PUSH_SUBSCRIPTIONS_MAX; n += 1) {
        await db
          .insertInto('push_subscriptions')
          .values({
            user_id: alice.userId,
            session_id: alice.sessionId,
            endpoint: `https://push.example.com/old/${String(n).padStart(3, '0')}`,
            p256dh: P256DH,
            auth: AUTH,
            server_key: SERVER_PUBLIC,
            created_at: new Date(NOW.getTime() - (PUSH_SUBSCRIPTIONS_MAX - n + 1) * 60_000),
          })
          .execute();
      }
      expect(await rows(db, alice.userId)).toHaveLength(PUSH_SUBSCRIPTIONS_MAX);
      expect((await call(db, 'POST', '/api/push/subscriptions', alice, device(3))).status).toBe(
        204,
      );
      const kept = await rows(db, alice.userId);
      expect(kept).toHaveLength(PUSH_SUBSCRIPTIONS_MAX);
      expect(kept).not.toContain('https://push.example.com/old/001');
      expect(kept).toContain('https://push.example.com/send/3');
    });
  });

  test('refuses what a browser never sends: not https, an address too long, a key that is no point', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'push-bad');
      const refused = async (body: unknown): Promise<number> =>
        (await call(db, 'POST', '/api/push/subscriptions', alice, body)).status;
      expect(
        await refused({ ...(device(4) as object), endpoint: 'http://push.example.com/send/4' }),
      ).toBe(400);
      expect(
        await refused({
          ...(device(4) as object),
          endpoint: `https://push.example.com/${'a'.repeat(2048)}`,
        }),
      ).toBe(400);
      // The right length, and not a point on the curve.
      expect(
        await refused({
          ...(device(4) as object),
          keys: { p256dh: `B${'A'.repeat(86)}`, auth: AUTH },
        }),
      ).toBe(400);
      expect(await rows(db, alice.userId)).toEqual([]);
      expect((await call(db, 'POST', '/api/push/subscriptions', undefined, device(4))).status).toBe(
        401,
      );
    });
  });

  test('is 503 PUSH_UNAVAILABLE where push is off, and stores nothing', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'push-off');
      const off = await call(db, 'POST', '/api/push/subscriptions', alice, device(5), testConfig());
      expect(off.status).toBe(503);
      expect(await rows(db, alice.userId)).toEqual([]);
    });
  });
});

describe('integration: a device stops being told', () => {
  test('removing removes one’s own; somebody else’s endpoint is the same 204 and stays', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'push-rm-a');
      const bob = await aSignedInUser(db, clock, 'push-rm-b');
      await call(db, 'POST', '/api/push/subscriptions', alice, device(6));
      await call(db, 'POST', '/api/push/subscriptions', bob, device(7));
      const remove = async (as: SignedInUser, n: number): Promise<number> =>
        (
          await call(db, 'POST', '/api/push/subscriptions/remove', as, {
            endpoint: `https://push.example.com/send/${String(n)}`,
          })
        ).status;
      expect(await remove(bob, 6)).toBe(204);
      expect(await rows(db, alice.userId)).toEqual(['https://push.example.com/send/6']);
      expect(await remove(alice, 6)).toBe(204);
      expect(await rows(db, alice.userId)).toEqual([]);
      expect(await rows(db, bob.userId)).toEqual(['https://push.example.com/send/7']);
    });
  });

  test('signing out deletes the session’s devices', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'push-out');
      await call(db, 'POST', '/api/push/subscriptions', alice, device(8));
      expect((await call(db, 'POST', '/auth/logout', alice)).status).toBeLessThan(400);
      expect(await rows(db, alice.userId)).toEqual([]);
    });
  });
});

describe('integration: the language a person is told in', () => {
  test('is set by their client, and only to one the interface has', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'push-locale');
      expect((await call(db, 'PUT', '/api/me/locale', alice, { locale: 'tr' })).status).toBe(204);
      const row = await db
        .selectFrom('users')
        .select('locale')
        .where('id', '=', alice.userId)
        .executeTakeFirstOrThrow();
      expect(row.locale).toBe('tr');
      expect((await call(db, 'PUT', '/api/me/locale', alice, { locale: 'de' })).status).toBe(400);
    });
  });
});
