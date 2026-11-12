/** Retiring multiple occurrences must compose with a provider's subscription-wide 410 cascade. */
import { afterAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase, sql } from '@purlay/db';
import { messageId } from '@purlay/types';
import { send } from '../../features/chat/messages/messages';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { credentialCipher } from '../../platform/crypto';
import { NO_LOG } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { NOW, testConfig } from '../../testing/doubles';
import { pendingPush, PUSH_QUIET_BUS } from '../../testing/pending-push';
import { aSignedInUser, aTestAuth } from '../../testing/signed-in';
import { requireServerAdmin } from '../setup/setup';
import { createDelivery } from './delivery';
import { devicesFor } from './devices';
import { createFailureCount } from './failures';
import { maintainPushes } from './maintenance';
import { claimPush } from './queue';
import type { PushOutcome } from './queue-result';
import { pushConfiguration } from './settings';

afterAll(closeIntegrationDatabase);

describe('integration: response cascade concurrency', () => {
  for (const retirement of ['disable', 'expiry'] as const) {
    test(`integration: a 410 and ${retirement} retire two occurrences without a cascade deadlock`, async () => {
      const owned = await cloneIntegrationDatabase();
      const held = Promise.withResolvers<number>();
      const resume = Promise.withResolvers<undefined>();
      let retiring: Promise<void> | undefined;
      let delivering: Promise<PushOutcome> | undefined;
      try {
        const world = await pendingPush(owned.db);
        const later = await send(
          { atomically: atomicallyOn(owned.db), clock: world.clock, bus: PUSH_QUIET_BUS },
          world.room.members['writer']!.context,
          {
            id: messageId(new Date(NOW.getTime() + 1)),
            content: `@${world.room.members['reader']!.username} another occurrence`,
          },
        );
        const sibling = await owned.db
          .selectFrom('push_intents')
          .select('id')
          .where('record_id', '=', later.id)
          .executeTakeFirstOrThrow();
        await owned.db
          .updateTable('push_intents')
          .set({ next_check_at: new Date(NOW.getTime() - 1) })
          .where('record_id', '=', world.message)
          .execute();
        expect(
          await owned.db
            .selectFrom('push_deliveries')
            .select('intent_id')
            .where(
              'subscription_id',
              'in',
              world.devices.map((device) => device.id),
            )
            .execute(),
        ).toHaveLength(2);
        if (retirement === 'expiry')
          await owned.db
            .updateTable('push_intents')
            .set({
              created_at: new Date(NOW.getTime() - 86_400_000 + 1_000),
              expires_at: new Date(NOW.getTime() + 1_000),
            })
            .execute();
        const administrator = await aSignedInUser(owned.db, world.clock, 'push-administrator');
        await owned.db
          .updateTable('users')
          .set({ is_server_admin: true })
          .where('id', '=', administrator.userId)
          .execute();
        const admin = await requireServerAdmin(
          aTestAuth(owned.db, { clock: world.clock }),
          owned.db,
          new Headers({ cookie: administrator.cookie }),
        );
        const dependencies = world.dependencies(async () => {
          retiring = owned.db.transaction().execute(async (tx) => {
            await sql`set local statement_timeout = '5s'`.execute(tx);
            await tx
              .selectFrom('push_deliveries')
              .select('intent_id')
              .where('intent_id', '=', sibling.id)
              .forUpdate()
              .execute();
            const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx);
            held.resolve(pid.rows[0]!.pid);
            await resume.promise;
            if (retirement === 'disable')
              await pushConfiguration(
                tx,
                credentialCipher(DEVELOPMENT_ENCRYPTION_KEY),
                world.clock,
                testConfig(),
              ).change(admin, false);
            else await maintainPushes(tx, world.clock.now(), NO_LOG, () => undefined);
          });
          // The result is observed below immediately, including PostgreSQL's deadlock victim.
          void retiring.catch(() => undefined);
          await held.promise;
          return { kind: 'answered', status: 410 };
        });
        const claim = (await claimPush(dependencies))!;
        expect(claim.intentId).not.toBe(sibling.id);
        const [device] = await devicesFor(
          dependencies,
          world.message,
          [world.reader],
          world.notification,
        );
        const deliver = await createDelivery(dependencies, {
          failed: createFailureCount(dependencies),
        });
        delivering = deliver(device!, claim);
        void delivering.catch(() => undefined);
        const blocker = await held.promise;
        let waiting = false;
        for (let n = 0; n < 200 && !waiting; n += 1) {
          const result = await sql<{ waiting: boolean }>`select exists(
          select 1 from pg_stat_activity where ${blocker} = any(pg_blocking_pids(pid))
        ) as waiting`.execute(owned.db);
          waiting = result.rows[0]?.waiting === true;
          if (!waiting) await Bun.sleep(5);
        }
        expect(waiting).toBe(true);
        if (retirement === 'expiry') world.clock.to(new Date(NOW.getTime() + 1_000));
        resume.resolve(undefined);
        const results = await Promise.allSettled([retiring, delivering]);
        expect(
          results.map((result) =>
            result.status === 'fulfilled'
              ? result.status
              : (result.reason as { code?: string }).code,
          ),
        ).toEqual(['fulfilled', 'fulfilled']);
        expect(
          await owned.db
            .selectFrom('push_subscriptions')
            .select('id')
            .where('user_id', '=', world.reader)
            .execute(),
        ).toEqual([]);
        expect(
          await owned.db
            .selectFrom('push_deliveries')
            .select('intent_id')
            .where(
              'subscription_id',
              'in',
              world.devices.map((device) => device.id),
            )
            .execute(),
        ).toEqual([]);
        if (retirement === 'expiry') {
          await maintainPushes(owned.db, world.clock.now(), NO_LOG, () => undefined);
          expect(
            await owned.db
              .selectFrom('push_intents')
              .select('id')
              .where('user_id', '=', world.reader)
              .execute(),
          ).toEqual([]);
        } else {
          const settings = await owned.db
            .selectFrom('server_settings')
            .select('push_enabled')
            .where('id', '=', true)
            .executeTakeFirstOrThrow();
          expect(settings.push_enabled).toBe(false);
        }
      } finally {
        resume.resolve(undefined);
        await Promise.allSettled([retiring, delivering]);
        await owned.drop();
      }
    }, 30_000);
  }
});
