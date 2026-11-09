import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { ServerPushSettings } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { NOW, testConfig, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});
const clock = fixedClock(NOW);
const call = async (
  db: Executor,
  method: string,
  path: string,
  user?: SignedInUser,
  body?: unknown,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock })).handle(
    new Request(`https://purlay.test${path}`, {
      method,
      headers: {
        origin: 'https://purlay.test',
        ...(user === undefined ? {} : { cookie: user.cookie }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

describe('integration: server browser push administration', () => {
  test('guards reads and writes before parsing and initializes nothing for outsiders', async () => {
    await withRollback(async (db) => {
      const member = await aSignedInUser(db, clock, 'push-member');
      for (const user of [undefined, member]) {
        expect((await call(db, 'GET', '/api/server/push', user)).status).toBe(404);
        expect((await call(db, 'PUT', '/api/server/push', user, { enabled: 'yes' })).status).toBe(
          404,
        );
      }
      expect(
        await db
          .selectFrom('server_settings')
          .where('id', '=', true)
          .select('push_imported_from_env_at')
          .executeTakeFirst(),
      ).toBeUndefined();
    });
  });

  test('a real administrator can enable and disable without a restart; key and overview follow the saved state', async () => {
    await withRollback(async (db) => {
      const user = await aSignedInUser(db, clock, 'push-manager');
      await db
        .updateTable('users')
        .set({ is_server_admin: true })
        .where('id', '=', user.userId)
        .execute();
      const off = await call(db, 'GET', '/api/server/push', user);
      expect(off.status).toBe(200);
      expect(await off.json()).toEqual({ enabled: false, keysCreated: false, subject: null });
      for (const body of [{ enabled: 'yes' }, { enabled: true, privateKey: 'attacker' }, {}])
        expect((await call(db, 'PUT', '/api/server/push', user, body)).status).toBe(400);
      const on = await call(db, 'PUT', '/api/server/push', user, { enabled: true });
      expect(on.status).toBe(200);
      const publicView: unknown = await on.json();
      expect(Value.Check(ServerPushSettings, publicView)).toBe(true);
      expect(publicView).toEqual({
        enabled: true,
        keysCreated: true,
        subject: testConfig().APP_URL,
      });
      const key = (await (await call(db, 'GET', '/api/push/key', user)).json()) as {
        publicKey: string;
      };
      expect(key.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
      const overview = (await (await call(db, 'GET', '/api/server/overview', user)).json()) as {
        pushConfigured: boolean;
      };
      expect(overview.pushConfigured).toBe(true);
      const disabled = await call(db, 'PUT', '/api/server/push', user, { enabled: false });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toEqual({
        enabled: false,
        keysCreated: true,
        subject: testConfig().APP_URL,
      });
      expect(await (await call(db, 'GET', '/api/push/key', user)).json()).toEqual({
        publicKey: null,
      });
      await call(db, 'PUT', '/api/server/push', user, { enabled: true });
      expect(await (await call(db, 'GET', '/api/push/key', user)).json()).toEqual(key);
      await db
        .updateTable('users')
        .set({ is_server_admin: false })
        .where('id', '=', user.userId)
        .execute();
      expect((await call(db, 'PUT', '/api/server/push', user, { enabled: false })).status).toBe(
        404,
      );
    });
  });
});
