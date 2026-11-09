import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  type Executor,
} from '@purlay/db';
import { credentialCipher, SealBroken } from '../../platform/crypto';
import { fixedClock } from '../../platform/clock';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { NOW, testConfig } from '../../testing/doubles';
import { aSignedInUser, aTestAuth } from '../../testing/signed-in';
import { requireServerAdmin, type ServerAdminSession } from '../setup/setup';
import * as audit from '../audit/server-audit';
import { KEYS } from '../../testing/push-service';
import { pushConfiguration } from './settings';
import { vapidSigningKey } from './vapid';

afterAll(async () => {
  await closeIntegrationDatabase();
});
const failure = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to fail');
};
const clock = fixedClock(NOW);
const cipher = credentialCipher(DEVELOPMENT_ENCRYPTION_KEY);
const environment = testConfig();
const adminOf = async (db: Executor): Promise<ServerAdminSession> => {
  const user = await aSignedInUser(db, clock, 'push-admin');
  await db
    .updateTable('users')
    .set({ is_server_admin: true })
    .where('id', '=', user.userId)
    .execute();
  return await requireServerAdmin(
    aTestAuth(db, { clock }),
    db,
    new Headers({ cookie: user.cookie }),
  );
};
const seeded = {
  ...environment,
  VAPID_PUBLIC_KEY: KEYS.publicKey,
  VAPID_PRIVATE_KEY: KEYS.privateKey,
  VAPID_SUBJECT: KEYS.subject,
};

describe('integration: persisted server push settings', () => {
  test('off by default; generates once, seals the scalar, and keeps the pair across disable, restart and re-enable', async () => {
    await withRollback(async (db) => {
      const admin = await adminOf(db);
      const settings = pushConfiguration(db, cipher, clock, environment);
      expect(await settings.view()).toEqual({ enabled: false, keysCreated: false, subject: null });
      expect(await settings.keys()).toBeUndefined();
      expect(await settings.change(admin, true)).toEqual({
        enabled: true,
        keysCreated: true,
        subject: environment.APP_URL,
      });
      const keys = await settings.keys();
      if (keys === undefined) throw new Error('expected generated keys');
      expect(keys.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
      expect(keys.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await vapidSigningKey(keys)).toBeDefined();
      const row = await db
        .selectFrom('server_settings')
        .where('id', '=', true)
        .select('push_private_key_encrypted')
        .executeTakeFirstOrThrow();
      expect(row.push_private_key_encrypted).not.toContain(keys.privateKey);
      expect(
        await cipher.open(
          Buffer.from(row.push_private_key_encrypted ?? '', 'base64'),
          'server_settings.push_private_key_encrypted',
        ),
      ).toBe(keys.privateKey);
      expect(
        await failure(
          cipher.open(
            Buffer.from(row.push_private_key_encrypted ?? '', 'base64'),
            'server_settings.smtp_url_encrypted',
          ),
        ),
      ).toBeInstanceOf(SealBroken);
      expect(JSON.stringify(await settings.view())).not.toContain(keys.privateKey);
      await settings.change(admin, true);
      await settings.change(admin, false);
      expect(await settings.keys()).toBeUndefined();
      const restarted = pushConfiguration(db, cipher, clock, seeded);
      expect((await restarted.view()).enabled).toBe(false);
      await restarted.change(admin, true);
      expect(await restarted.keys()).toEqual(keys);
      const rows = await db
        .selectFrom('server_audit_log')
        .selectAll()
        .where('action', 'in', ['server.push_enabled', 'server.push_disabled'])
        .orderBy('id')
        .execute();
      expect(rows.map((r) => r.action).sort()).toEqual([
        'server.push_disabled',
        'server.push_enabled',
        'server.push_enabled',
      ]);
      expect(JSON.stringify(rows)).not.toContain(keys.publicKey);
      expect(JSON.stringify(rows)).not.toContain(keys.privateKey);
    });
  });

  test('upgrades an existing server settings row with its existing environment keys', async () => {
    await withRollback(async (db) => {
      await db.insertInto('server_settings').values({ id: true }).execute();
      expect(await pushConfiguration(db, cipher, clock, seeded).keys()).toEqual(KEYS);
    });
  });

  test('imports an existing environment pair once and keeps it when the environment changes or disappears', async () => {
    await withRollback(async (db) => {
      const initial = pushConfiguration(db, cipher, clock, seeded);
      expect(await initial.keys()).toEqual(KEYS);
      expect(await pushConfiguration(db, cipher, clock, environment).keys()).toEqual(KEYS);
      expect(
        await db
          .selectFrom('server_audit_log')
          .select('id')
          .where('action', 'in', ['server.push_enabled', 'server.push_disabled'])
          .execute(),
      ).toHaveLength(0);
    });
  });

  test('a revoked administrator cannot initialize or change settings', async () => {
    await withRollback(async (db) => {
      const admin = await adminOf(db);
      await db
        .updateTable('users')
        .set({ is_server_admin: false })
        .where('id', '=', admin.userId)
        .execute();
      expect(
        await failure(pushConfiguration(db, cipher, clock, environment).change(admin, true)),
      ).toMatchObject({ body: { code: 'ROUTE_NOT_FOUND' } });
      const row = await db
        .selectFrom('server_settings')
        .where('id', '=', true)
        .select('push_imported_from_env_at')
        .executeTakeFirst();
      expect(row?.push_imported_from_env_at ?? null).toBeNull();
    });
  });

  test('a broken seal prevents sending or re-enabling and is never silently replaced', async () => {
    await withRollback(async (db) => {
      const admin = await adminOf(db);
      const settings = pushConfiguration(db, cipher, clock, seeded);
      expect(await settings.keys()).toEqual(KEYS);
      const original = await db
        .selectFrom('server_settings')
        .where('id', '=', true)
        .select('push_private_key_encrypted')
        .executeTakeFirstOrThrow();
      const other = pushConfiguration(
        db,
        credentialCipher(Buffer.alloc(32, 9).toString('base64')),
        clock,
        environment,
      );
      expect(await failure(other.keys())).toBeInstanceOf(SealBroken);
      await other.change(admin, false);
      expect(await failure(other.change(admin, true))).toBeInstanceOf(SealBroken);
      expect((await settings.view()).enabled).toBe(false);
      expect(
        await db
          .selectFrom('server_settings')
          .where('id', '=', true)
          .select('push_private_key_encrypted')
          .executeTakeFirstOrThrow(),
      ).toEqual(original);
    });
  });

  test('concurrent first enables generate one pair, and an audit failure rolls the change back', async () => {
    const cloned = await cloneIntegrationDatabase();
    try {
      const db = cloned.db;
      const admin = await adminOf(db);
      const first = pushConfiguration(db, cipher, clock, environment);
      const second = pushConfiguration(db, cipher, clock, environment);
      await Promise.all([first.change(admin, true), second.change(admin, true)]);
      expect(await first.keys()).toEqual(await second.keys());
      expect(
        await db
          .selectFrom('server_audit_log')
          .select('id')
          .where('action', '=', 'server.push_enabled')
          .execute(),
      ).toHaveLength(1);
      const broken = spyOn(audit, 'recordServerAudit').mockRejectedValueOnce(
        new Error('audit unavailable'),
      );
      try {
        expect(await failure(first.change(admin, false))).toMatchObject({
          message: 'audit unavailable',
        });
      } finally {
        broken.mockRestore();
      }
      expect((await first.view()).enabled).toBe(true);
      expect(
        await db
          .selectFrom('server_audit_log')
          .select('id')
          .where('action', '=', 'server.push_disabled')
          .execute(),
      ).toHaveLength(0);
    } finally {
      await cloned.drop();
    }
  });
});
