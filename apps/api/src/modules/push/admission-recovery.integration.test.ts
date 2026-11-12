/** An occurrence spends one admission across its devices; restarting a sender does not reset it. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback } from '@purlay/db';
import { nobodyActive } from '../../platform/attention';
import { NO_LOG } from '../../platform/events';
import { NOW } from '../../testing/doubles';
import { TEST_PUSH_POLICY } from '../../testing/push-config';
import { aBrowser, aPushService, KEYS } from '../../testing/push-service';
import { aWorld, subscribe, words } from '../../testing/push-world';
import { pendingPush } from '../../testing/pending-push';
import { noPushNotices } from './notices';
import { createPushSender } from './sender';

afterAll(closeIntegrationDatabase);

describe('integration: admission recovery', () => {
  test('waits for migrated settings before recovering committed work', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const readiness = { available: false };
      const service = aPushService();
      const worker = await createPushSender({
        ...world.dependencies(service.post),
        available: () => readiness.available,
      });
      await worker.flush(10_000);
      expect(service.sent).toEqual([]);
      expect(
        await db
          .selectFrom('push_deliveries')
          .select('attempts')
          .where('subscription_id', '=', world.devices[0]!.id)
          .execute(),
      ).toEqual([{ attempts: 0 }]);
      readiness.available = true;
      await worker.releaseHeld();
      await worker.flush(10_000);
      expect(service.sent).toHaveLength(1);
    });
  });
  test('integration: restart preserves admission while all three devices share one occurrence token', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (let n = 0; n < 3; n += 1) {
        await subscribe(db, world.clock, world.ada, await aBrowser());
        await db
          .updateTable('push_subscriptions')
          .set({ endpoint: `https://push.example.com/admission/${world.ada}/${String(n)}` })
          .where('user_id', '=', world.ada)
          .where('endpoint', '=', `https://push.example.com/send/${world.ada}`)
          .execute();
      }
      const service = aPushService();
      const dependencies = {
        ...TEST_PUSH_POLICY,
        database: db,
        clock: world.clock,
        log: NO_LOG,
        keys: KEYS,
        attention: nobodyActive,
        notices: noPushNotices,
        noticeWords: words,
        post: service.post,
      };
      for (let occurrence = 0; occurrence < 3; occurrence += 1) {
        await world.write(world.ada);
        const restarted = await createPushSender(dependencies);
        await restarted.flush(10_000);
        expect(service.sent).toHaveLength((occurrence + 1) * 3);
      }
      const refused = await world.write(world.ada);
      const restarted = await createPushSender(dependencies);
      await restarted.flush(10_000);
      expect(service.sent).toHaveLength(9);
      expect(
        await db
          .selectFrom('push_intents')
          .select('state')
          .where('source_id', '=', refused.entryId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: 'throttled' });
      world.clock.to(new Date(NOW.getTime() + 60_000));
      await world.write(world.ada);
      const refilled = await createPushSender(dependencies);
      await refilled.flush(10_000);
      expect(service.sent).toHaveLength(12);
      expect(new Set(service.sent.map((sent) => sent.headers['topic'])).size).toBe(12);
    });
  });
});
