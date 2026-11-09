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
import { routeInbox, type DeviceFinder } from './devices';

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
});
