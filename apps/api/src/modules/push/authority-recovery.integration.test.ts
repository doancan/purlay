/** A delayed push never revives old authority, an old notification occurrence or a retired browser lifetime. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { messageId } from '@purlay/types';
import { credentialCipher } from '../../platform/crypto';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { atomicallyOn } from '../../platform/transactions';
import { NO_LOG } from '../../platform/events';
import { nobodyActive } from '../../platform/attention';
import { effectiveModules } from '../../platform/module-kit/entitlement';
import { PUSH_LEASE_MS } from '../../platform/push-policy';
import { send } from '../../features/chat/messages/messages';
import { chatPushNotices } from '../../features/chat/notifications/push-notices';
import { pendingPush, PUSH_QUIET_BUS } from '../../testing/pending-push';
import { NOW, testConfig } from '../../testing/doubles';
import { TEST_PUSH_POLICY } from '../../testing/push-config';
import { aBrowser, aPushService, KEYS } from '../../testing/push-service';
import { aWorld, subscribe, words } from '../../testing/push-world';
import { aSignedInUser, aTestAuth } from '../../testing/signed-in';
import { requireServerAdmin } from '../setup/setup';
import { currentPushDevice, currentPushSource } from './authority';
import { claimPush } from './queue';
import { createPushSender, type PushSenderDependencies } from './sender';
import { noPushNotices } from './notices';
import { pushConfiguration } from './settings';

afterAll(closeIntegrationDatabase);

describe('integration: recovered push authority', () => {
  test('an unread later occurrence cannot make a read occurrence eligible again', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const dependencies = world.dependencies(aPushService().post);
      const claim = (await claimPush(dependencies))!;
      expect(await currentPushSource(dependencies, claim)).toBe(true);
      await db
        .updateTable('notifications')
        .set({ read_at: NOW })
        .where('id', '=', world.notification)
        .execute();
      await db
        .insertInto('notifications')
        .values({
          user_id: world.reader,
          workspace_id: world.room.workspaceId,
          channel_id: world.room.channelId,
          message_id: world.message,
          type: 'reminder',
          created_at: NOW,
        })
        .execute();
      expect(await chatPushNotices.canDeliver(db, world.message, world.reader)).toBe(true);
      expect(
        await chatPushNotices.canDeliver(db, world.message, world.reader, world.notification),
      ).toBe(false);
      expect(
        await chatPushNotices.of(db, world.message, [world.reader], world.notification),
      ).toEqual([]);
      expect(await currentPushSource(dependencies, claim)).toBe(false);
      world.clock.to(new Date(NOW.getTime() + PUSH_LEASE_MS));
      const service = aPushService();
      const worker = await createPushSender(world.dependencies(service.post));
      await worker.flush(10_000);
      expect(service.sent).toEqual([]);
    });
  });

  test('changing browser keys and changing them back cannot resurrect the original lifetime', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const queue = world.dependencies(aPushService().post);
      const claim = (await claimPush(queue))!;
      const original = await db
        .selectFrom('push_subscriptions')
        .selectAll()
        .where('user_id', '=', world.reader)
        .executeTakeFirstOrThrow();
      await db
        .updateTable('push_subscriptions')
        .set({ auth: (await aBrowser()).auth })
        .where('id', '=', original.id)
        .execute();
      await db
        .updateTable('push_subscriptions')
        .set({ auth: original.auth })
        .where('id', '=', original.id)
        .execute();
      expect(await currentPushDevice(queue, claim)).toBeUndefined();
      expect(
        (
          await db
            .selectFrom('push_subscriptions')
            .select('generation')
            .where('user_id', '=', world.reader)
            .executeTakeFirstOrThrow()
        ).generation,
      ).not.toBe(original.generation);
      world.clock.to(new Date(NOW.getTime() + PUSH_LEASE_MS));
      const service = aPushService();
      const worker = await createPushSender(world.dependencies(service.post));
      await worker.flush(10_000);
      expect(service.sent).toEqual([]);
    });
  });

  test('a device registered after a source commit receives no historical push from a late hint', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db, 0);
      expect(
        await db
          .selectFrom('push_intents')
          .select('id')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([]);
      await subscribe(db, world.clock, world.reader, await aBrowser());
      const service = aPushService();
      const worker = await createPushSender(world.dependencies(service.post));
      worker.told(world.message, [world.reader]);
      await worker.flush(10_000);
      expect(service.sent).toEqual([]);
    });
  });

  test('global disable retires old work, keeps device choices, and re-enable captures only new sources', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const admin = await aSignedInUser(db, world.clock, 'push-owner');
      await db
        .updateTable('users')
        .set({ is_server_admin: true })
        .where('id', '=', admin.userId)
        .execute();
      const session = await requireServerAdmin(
        aTestAuth(db, { clock: world.clock }),
        db,
        new Headers({ cookie: admin.cookie }),
      );
      const settings = pushConfiguration(
        db,
        credentialCipher(DEVELOPMENT_ENCRYPTION_KEY),
        world.clock,
        testConfig(),
      );
      await settings.change(session, false);
      expect(
        await db
          .selectFrom('push_intents')
          .select('state')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([{ state: 'canceled' }]);
      expect(
        await db
          .selectFrom('push_subscriptions')
          .select('id')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toHaveLength(1);
      await send(
        { atomically: atomicallyOn(db), clock: world.clock, bus: PUSH_QUIET_BUS },
        world.room.members['writer']!.context,
        {
          id: messageId(new Date(NOW.getTime() + 1)),
          content: `@${world.room.members['reader']!.username} while disabled`,
        },
      );
      await settings.change(session, true);
      const service = aPushService();
      const worker = await createPushSender(world.dependencies(service.post));
      worker.told(world.message, [world.reader]);
      await worker.flush(10_000);
      expect(service.sent).toEqual([]);
      await send(
        { atomically: atomicallyOn(db), clock: world.clock, bus: PUSH_QUIET_BUS, push: worker },
        world.room.members['writer']!.context,
        {
          id: messageId(new Date(NOW.getTime() + 2)),
          content: `@${world.room.members['reader']!.username} new`,
        },
      );
      await worker.flush(10_000);
      expect(service.sent).toHaveLength(1);
    });
  });

  test('a module-none node leaves unknown work for a node which understands it', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const service = aPushService();
      const empty = await createPushSender({
        ...world.dependencies(service.post),
        owner: 'core',
        inboxKinds: new Map(),
        notices: noPushNotices,
        effectiveModules: () => new Set(),
      });
      await empty.flush(10_000);
      expect(service.sent).toEqual([]);
      expect(
        await db
          .selectFrom('push_deliveries')
          .select('attempts')
          .where(
            'subscription_id',
            'in',
            world.devices.map((device) => device.id),
          )
          .execute(),
      ).toEqual([{ attempts: 0 }]);
      const known = await createPushSender(world.dependencies(service.post));
      await known.flush(10_000);
      expect(service.sent).toHaveLength(1);
    });
  });

  for (const change of [
    'read',
    'membership removed',
    'guest',
    'workspace deleted',
    'person deleted',
    'person suspended',
  ] as const) {
    test(`the current inbox source rejects ${change} even for an already issued claim`, async () => {
      await withRollback(async (db) => {
        const world = await aWorld(db);
        await subscribe(db, world.clock, world.ada, await aBrowser());
        const entry = await world.write(world.ada);
        const dependencies = {
          ...TEST_PUSH_POLICY,
          database: db,
          clock: world.clock,
          notices: noPushNotices,
        };
        const claim = (await claimPush(dependencies))!;
        expect(claim.sourceId).toBe(entry.entryId);
        expect(await currentPushSource(dependencies, claim)).toBe(true);
        if (change === 'read')
          await db
            .updateTable('inbox_entries')
            .set({ read_at: world.clock.now() })
            .where('id', '=', entry.entryId)
            .execute();
        else if (change === 'membership removed')
          await db
            .deleteFrom('workspace_members')
            .where('workspace_id', '=', world.workspaceId)
            .where('user_id', '=', world.ada)
            .execute();
        else if (change === 'guest')
          await db
            .updateTable('workspace_members')
            .set({ access_kind: 'guest', guest_since: world.clock.now(), guest_modules: ['chat'] })
            .where('workspace_id', '=', world.workspaceId)
            .where('user_id', '=', world.ada)
            .execute();
        else if (change === 'workspace deleted')
          await db
            .updateTable('workspaces')
            .set({ deleted_at: world.clock.now() })
            .where('id', '=', world.workspaceId)
            .execute();
        else
          await db
            .updateTable('users')
            .set(
              change === 'person deleted'
                ? { deleted_at: world.clock.now() }
                : { suspended_at: world.clock.now() },
            )
            .where('id', '=', world.ada)
            .execute();
        expect(await currentPushSource(dependencies, claim)).toBe(false);
      });
    });
  }

  for (const change of [
    'grant off',
    'grant expired',
    'membership removed',
    'account suspended',
    'read',
  ] as const) {
    test(`held inbox push rechecks ${change} after a restart (#1312)`, async () => {
      await withRollback(async (db) => {
        const world = await aWorld(db);
        await subscribe(db, world.clock, world.ada, await aBrowser());
        await db
          .updateTable('workspace_members')
          .set({ is_deep_work_active: true, deep_work_until: new Date(NOW.getTime() + 3_600_000) })
          .where('workspace_id', '=', world.workspaceId)
          .where('user_id', '=', world.ada)
          .execute();
        const service = aPushService();
        await db
          .insertInto('workspace_modules')
          .values({
            workspace_id: world.workspaceId,
            module: 'things',
            state: 'on',
            source: 'operator',
            changed_at: NOW,
            valid_until: change === 'grant expired' ? new Date(NOW.getTime() + 3_600_001) : null,
          })
          .execute();
        const dependencies: PushSenderDependencies = {
          database: db,
          clock: world.clock,
          log: NO_LOG,
          keys: KEYS,
          attention: nobodyActive,
          notices: noPushNotices,
          noticeWords: words,
          ...TEST_PUSH_POLICY,
          post: service.post,
          effectiveModules: (rows, now) =>
            effectiveModules({
              rows,
              now,
              mode: 'managed',
              running: [{ id: 'things', requires: [], entitlement: 'grant' }],
            }),
        };
        const entry = await world.write(world.ada);
        const first = await createPushSender(dependencies);
        await first.flush(10_000);
        expect(service.sent).toEqual([]);
        world.clock.to(new Date(NOW.getTime() + 3_600_001));
        if (change === 'grant off')
          await db
            .updateTable('workspace_modules')
            .set({ state: 'off' })
            .where('workspace_id', '=', world.workspaceId)
            .where('module', '=', 'things')
            .execute();
        if (change === 'membership removed')
          await db
            .deleteFrom('workspace_members')
            .where('workspace_id', '=', world.workspaceId)
            .where('user_id', '=', world.ada)
            .execute();
        if (change === 'account suspended')
          await db
            .updateTable('users')
            .set({ suspended_at: world.clock.now() })
            .where('id', '=', world.ada)
            .execute();
        if (change === 'read')
          await db
            .updateTable('inbox_entries')
            .set({ read_at: world.clock.now() })
            .where('id', '=', entry.entryId)
            .execute();
        const restarted = await createPushSender(dependencies);
        await restarted.flush(10_000);
        expect(service.sent).toEqual([]);
        expect(
          await db
            .selectFrom('push_deliveries')
            .select('state')
            .where(
              'intent_id',
              'in',
              db.selectFrom('push_intents').select('id').where('source_id', '=', entry.entryId),
            )
            .execute(),
        ).toEqual([{ state: 'canceled' }]);
      });
    });
  }
});
