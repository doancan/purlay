/**
 * Which devices a notice of the core's inbox is for (`devices.ts`), asked of the choice itself. The sender
 * asks again right before it posts (a person who read it meanwhile is not pushed), so a test that goes
 * through the whole sender cannot tell a choice that forgot a rule from one that holds it twice: these
 * two rules are held here, where nothing after the choice can hide them.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { inMemoryAttention, nobodyActive, type Attention } from '../../platform/attention';
import { aRecordingLogger } from '../../testing/doubles';
import { aWorld, subscribe, words } from '../../testing/push-world';
import { aBrowser, KEYS } from '../../testing/push-service';
import { aSession } from '../../testing/signed-in';
import { routeInbox, type DeviceFinder } from './devices';
import { currentPushDevice } from './authority';
import type { PushClaim } from './queue';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: the devices a notice of the inbox is for', () => {
  const finderOn = (
    world: Awaited<ReturnType<typeof aWorld>>,
    database: DeviceFinder['database'],
    attention: Attention,
  ): DeviceFinder => ({
    database,
    clock: world.clock,
    keys: KEYS,
    log: aRecordingLogger().log,
    attention,
    notices: { of: () => Promise.resolve([]), canDeliver: () => Promise.resolve(false) },
    noticeWords: words,
  });

  test('a person with an unread notice and nobody looking has their device told', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      const written = await world.write(world.ada);
      const routed = await routeInbox(finderOn(world, db, nobodyActive), [written.entryId]);
      expect(routed.devices).toHaveLength(1);
      expect(routed.waiting.size).toBe(0);
    });
  });

  test('a notice read meanwhile is not worth a push, whatever else is true of it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      const written = await world.write(world.ada);
      await db
        .updateTable('inbox_entries')
        .set({ read_at: world.clock.now() })
        .where('id', '=', written.entryId)
        .execute();
      const routed = await routeInbox(finderOn(world, db, nobodyActive), [written.entryId]);
      expect(routed.devices).toEqual([]);
    });
  });

  test('a person looking at the workspace’s page is not pushed what the page already says (D-143)', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await subscribe(db, world.clock, world.ada, await aBrowser());
      const written = await world.write(world.ada);
      const looking = inMemoryAttention(world.clock);
      looking.heard(world.ada, world.workspaceId);
      const routed = await routeInbox(finderOn(world, db, looking), [written.entryId]);
      expect(routed.devices).toEqual([]);
      // Held for later is Deep Work's: looking at the page is not that, and nothing waits.
      expect(routed.waiting.size).toBe(0);
    });
  });

  test('routes a held inbox notice to the current APNs registration in its language, with no browser key', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const { sessionId } = await aSession(db, world.clock, world.ada);
      const scope = 'purlay-ios-sandbox';
      const deviceToken = '12'.repeat(32);
      const registeredAt = world.clock.now();
      const { generation } = await db
        .insertInto('apns_subscriptions')
        .values({
          session_id: sessionId,
          device_token: deviceToken,
          registered_at: registeredAt,
          provider_scope: scope,
        })
        .returning('generation')
        .executeTakeFirstOrThrow();
      await db.updateTable('users').set({ locale: 'tr' }).where('id', '=', world.ada).execute();
      const deepWorkEnds = new Date(world.clock.now().getTime() + 60_000);
      await db
        .updateTable('workspace_members')
        .set({ is_deep_work_active: true, deep_work_until: deepWorkEnds })
        .where('user_id', '=', world.ada)
        .execute();
      const notice = await world.write(world.ada);
      const finder: DeviceFinder = {
        ...finderOn(world, db, nobodyActive),
        keys: () => Promise.resolve(undefined),
        apnsScope: scope,
      };
      expect(await routeInbox(finder, [notice.entryId])).toEqual({
        devices: [],
        waiting: new Set([notice.entryId]),
      });
      world.clock.to(deepWorkEnds);
      expect(
        (await routeInbox({ ...finder, apnsScope: 'different-scope' }, [notice.entryId])).devices,
      ).toEqual([]);
      const routed = await routeInbox(finder, [notice.entryId]);
      expect(routed.devices).toHaveLength(1);
      expect(routed.devices[0]).toMatchObject({
        provider: 'apns',
        id: sessionId,
        sessionId,
        generation,
        apnsScope: scope,
        deviceToken,
        registeredAt,
        payload: { body: 'bob sana bir şey atadı' },
      });

      const claim: PushClaim = {
        source: 'inbox',
        sourceId: notice.entryId,
        recordId: notice.entryId,
        workspaceId: world.workspaceId,
        userId: world.ada,
        module: notice.module,
        kind: notice.kind,
        createdAt: world.clock.now(),
        expiresAt: new Date(world.clock.now().getTime() + 60_000),
        intentId: crypto.randomUUID(),
        leaseId: crypto.randomUUID(),
        attempts: 0,
        subscriptionId: sessionId,
        sessionId,
        generation,
        apnsScope: scope,
      };
      expect(await currentPushDevice(finder, claim)).toEqual({ sound: true });
      expect(
        await currentPushDevice(finder, { ...claim, apnsScope: 'different-scope' }),
      ).toBeUndefined();
      expect(await currentPushDevice(finder, { ...claim, userId: world.bob })).toBeUndefined();
      await db
        .updateTable('apns_subscriptions')
        .set({ generation: crypto.randomUUID() })
        .where('session_id', '=', sessionId)
        .execute();
      expect(await currentPushDevice(finder, claim)).toBeUndefined();
    });
  });
});
