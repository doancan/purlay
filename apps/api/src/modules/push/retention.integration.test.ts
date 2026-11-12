/** A full expiry batch must continue without waiting another minute while normal delivery still progresses. */
import { afterAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase, withRollback } from '@purlay/db';
import { NO_LOG } from '../../platform/events';
import { PUSH_TTL_SECONDS } from '../../platform/push-policy';
import { pendingPush } from '../../testing/pending-push';
import { NOW } from '../../testing/doubles';
import { aPushService } from '../../testing/push-service';
import { createPushSender } from './sender';
import { maintainPushes } from './maintenance';

afterAll(closeIntegrationDatabase);

describe('integration: retention', () => {
  test('integration: expired receipt backlog drains cooperatively beyond one batch without advancing the clock', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      const expired = new Date(NOW.getTime() - 1);
      await db
        .insertInto('push_intents')
        .values(
          Array.from({ length: 1_201 }, () => ({
            source_kind: 'message',
            source_id: crypto.randomUUID(),
            record_id: world.message,
            workspace_id: world.room.workspaceId,
            user_id: world.reader,
            module: 'chat',
            kind: 'mention',
            created_at: new Date(expired.getTime() - PUSH_TTL_SECONDS * 1_000),
            expires_at: expired,
            next_check_at: expired,
            state: 'completed',
          })),
        )
        .execute();
      const service = aPushService();
      const worker = await createPushSender(world.dependencies(service.post));
      await worker.flush(10_000);
      expect(service.sent).toHaveLength(1);
      expect(
        await db.selectFrom('push_intents').select('id').where('expires_at', '<=', NOW).execute(),
      ).toEqual([]);
      expect(
        await db
          .selectFrom('push_intents')
          .select('state')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([{ state: 'completed' }]);
    });
  });

  test('integration: a completely busy expiry batch yields and counts only rows actually retired', async () => {
    const owned = await cloneIntegrationDatabase();
    const held = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let blocking: Promise<void> | undefined;
    try {
      const world = await pendingPush(owned.db);
      const subscription = await owned.db
        .selectFrom('push_subscriptions')
        .select(['id', 'generation', 'session_id'])
        .where('user_id', '=', world.reader)
        .executeTakeFirstOrThrow();
      const expired = new Date(NOW.getTime() - 1);
      const rows = await owned.db
        .insertInto('push_intents')
        .values(
          Array.from({ length: 500 }, () => ({
            source_kind: 'message',
            source_id: crypto.randomUUID(),
            record_id: world.message,
            workspace_id: world.room.workspaceId,
            user_id: world.reader,
            module: 'chat',
            kind: 'mention',
            created_at: new Date(expired.getTime() - PUSH_TTL_SECONDS * 1_000),
            expires_at: expired,
            next_check_at: expired,
            state: 'admitted',
          })),
        )
        .returning('id')
        .execute();
      await owned.db
        .insertInto('push_deliveries')
        .values(
          rows.map((row) => ({
            intent_id: row.id,
            subscription_id: subscription.id,
            generation: subscription.generation,
            session_id: subscription.session_id,
            next_attempt_at: expired,
          })),
        )
        .execute();
      blocking = owned.db.transaction().execute(async (tx) => {
        await tx
          .selectFrom('push_deliveries')
          .select('intent_id')
          .where(
            'intent_id',
            'in',
            rows.map((row) => row.id),
          )
          .forUpdate()
          .execute();
        held.resolve(undefined);
        await release.promise;
      });
      await held.promise;
      let dropped = 0;
      const count = (_reason: string, n = 1): void => {
        dropped += n;
      };
      expect(await maintainPushes(owned.db, NOW, NO_LOG, count)).toBe(false);
      expect(dropped).toBe(0);
      expect(
        await owned.db
          .selectFrom('push_intents')
          .select('id')
          .where('expires_at', '<=', NOW)
          .execute(),
      ).toHaveLength(500);
      release.resolve(undefined);
      await blocking;
      expect(await maintainPushes(owned.db, NOW, NO_LOG, count)).toBe(true);
      expect(dropped).toBe(500);
      expect(
        await owned.db
          .selectFrom('push_intents')
          .select('id')
          .where('expires_at', '<=', NOW)
          .execute(),
      ).toEqual([]);
    } finally {
      release.resolve(undefined);
      await blocking;
      await owned.drop();
    }
  }, 30_000);
});
