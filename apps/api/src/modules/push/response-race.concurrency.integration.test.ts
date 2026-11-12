/** The provider answer's first lease read cannot authorize a later device mutation after a row-lock wait. */
import { afterAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase, sql } from '@purlay/db';
import { PUSH_LEASE_MS } from '../../platform/push-policy';
import { pendingPush } from '../../testing/pending-push';
import { NOW } from '../../testing/doubles';
import { aPushService } from '../../testing/push-service';
import { createDelivery } from './delivery';
import { devicesFor } from './devices';
import { createFailureCount } from './failures';
import { claimPush } from './queue';
import { settlePush, type PushOutcome } from './queue-result';

afterAll(closeIntegrationDatabase);

describe('integration: response race concurrency', () => {
  test('integration: a 410 cannot erase a device after a row-lock wait outlives its lease', async () => {
    const owned = await cloneIntegrationDatabase();
    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<undefined>();
    let blocker: Promise<void> | undefined;
    let result: Promise<PushOutcome> | undefined;
    try {
      const world = await pendingPush(owned.db);
      const dependencies = world.dependencies(async () => {
        blocker = owned.db.transaction().execute(async (tx) => {
          await sql`set local statement_timeout = '5s'`.execute(tx);
          await tx
            .selectFrom('push_subscriptions')
            .select('id')
            .where('id', '=', world.devices[0]!.id)
            .forUpdate()
            .execute();
          const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx);
          held.resolve(pid.rows[0]!.pid);
          await release.promise;
        });
        await held.promise;
        return { kind: 'answered', status: 410 };
      });
      const claim = (await claimPush(dependencies))!;
      const [device] = await devicesFor(
        dependencies,
        world.message,
        [world.reader],
        world.notification,
      );
      const deliver = await createDelivery(dependencies, {
        failed: createFailureCount(dependencies),
      });
      let completed = false;
      const deliveryFinished = (): boolean => completed;
      result = deliver(device!, claim).finally(() => {
        completed = true;
      });
      const blockerPid = await held.promise;
      let waiting = false;
      for (let n = 0; n < 200 && !waiting && !deliveryFinished(); n++) {
        const check = await sql<{
          waiting: boolean;
        }>`select exists(select 1 from pg_stat_activity where ${blockerPid} = any(pg_blocking_pids(pid))) as waiting`.execute(
          owned.db,
        );
        waiting = check.rows[0]?.waiting === true;
        if (!waiting && !deliveryFinished()) await Bun.sleep(5);
      }
      expect(waiting || completed).toBe(true);
      world.clock.to(new Date(NOW.getTime() + PUSH_LEASE_MS));
      const overlapping = await claimPush(world.dependencies(aPushService().post));
      release.resolve(undefined);
      await blocker;
      await settlePush(owned.db, claim, await result, world.clock);
      const replacement =
        overlapping ?? (await claimPush(world.dependencies(aPushService().post)))!;
      expect(replacement.leaseId).not.toBe(claim.leaseId);
      expect(
        await owned.db
          .selectFrom('push_subscriptions')
          .select('id')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toHaveLength(1);
      expect(
        await owned.db
          .selectFrom('push_deliveries')
          .select('lease_id')
          .where(
            'subscription_id',
            'in',
            world.devices.map((device) => device.id),
          )
          .execute(),
      ).toEqual([{ lease_id: replacement.leaseId }]);
    } finally {
      release.resolve(undefined);
      await Promise.allSettled([blocker, result]);
      await owned.drop();
    }
  }, 30_000);
});
