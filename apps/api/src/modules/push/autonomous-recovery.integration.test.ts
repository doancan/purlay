/** Recovery after a lost SQL acknowledgement and cooperative cleanup must not depend on timer luck. */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase, sql, withRollback } from '@purlay/db';
import { NO_LOG } from '../../platform/events';
import { PUSH_TTL_SECONDS } from '../../platform/push-policy';
import { NOW } from '../../testing/doubles';
import { pendingPush } from '../../testing/pending-push';
import { aPushService } from '../../testing/push-service';
import { createPushSender, type PushSender } from './sender';

afterAll(closeIntegrationDatabase);

describe('integration: autonomous push recovery', () => {
  test('a provider acceptance whose SQL acknowledgement fails stays leased and recovers with the same Topic', async () => {
    const owned = await cloneIntegrationDatabase();
    const workers: PushSender[] = [];
    try {
      const world = await pendingPush(owned.db);
      await sql`create function fail_push_acknowledgement() returns trigger language plpgsql as $$
        begin raise exception 'injected push acknowledgement failure'; end;
      $$`.execute(owned.db);
      await sql`create trigger fail_push_acknowledgement before update of state on push_deliveries
        for each row when (new.state = 'delivered') execute function fail_push_acknowledgement()`.execute(
        owned.db,
      );
      const service = aPushService();
      const stages: string[] = [];
      const worker = await createPushSender({
        ...world.dependencies(service.post),
        log: {
          ...NO_LOG,
          error: (_message, fields): void => {
            if (typeof fields?.['stage'] === 'string') stages.push(fields['stage']);
          },
        },
      });
      workers.push(worker);
      await worker.flush(10_000);
      expect(service.sent).toHaveLength(1);
      expect(stages).toEqual(['settling durable push']);
      const waiting = await owned.db
        .selectFrom('push_deliveries')
        .select(['state', 'attempts', 'lease_id', 'next_attempt_at'])
        .where('subscription_id', '=', world.devices[0]!.id)
        .executeTakeFirstOrThrow();
      expect(waiting).toMatchObject({ state: 'pending', attempts: 1 });
      expect(waiting.lease_id).not.toBeNull();
      await sql`drop trigger fail_push_acknowledgement on push_deliveries`.execute(owned.db);
      await sql`drop function fail_push_acknowledgement()`.execute(owned.db);
      world.clock.to(waiting.next_attempt_at);
      const recovered = await createPushSender(world.dependencies(service.post));
      workers.push(recovered);
      await recovered.flush(10_000);
      expect(service.sent).toHaveLength(2);
      expect(service.sent[1]!.headers['topic']).toBe(service.sent[0]!.headers['topic']);
      expect(Number(service.sent[1]!.headers['ttl'])).toBeLessThan(
        Number(service.sent[0]!.headers['ttl']),
      );
      expect(
        await owned.db
          .selectFrom('push_deliveries')
          .select(['state', 'attempts', 'lease_id'])
          .where('subscription_id', '=', world.devices[0]!.id)
          .execute(),
      ).toEqual([{ state: 'delivered', attempts: 2, lease_id: null }]);
    } finally {
      for (const worker of workers) await worker.flush(10_000);
      await owned.drop();
    }
  }, 30_000);

  test('cleanup continues after its cooperative yield without another hint, periodic poll or clock advance', async () => {
    await withRollback(async (db) => {
      const world = await pendingPush(db);
      await db
        .updateTable('push_intents')
        .set({ state: 'completed' })
        .where('user_id', '=', world.reader)
        .execute();
      const expired = new Date(NOW.getTime() - 1);
      const count = 2_001;
      await db
        .insertInto('push_intents')
        .values(
          Array.from({ length: count }, () => ({
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
            state: 'pending',
          })),
        )
        .execute();
      const retired = Promise.withResolvers<undefined>();
      let dropped = 0;
      // Hold the external periodic driver outside this test: only the zero-delay continuation may finish it.
      const inactivePolling = setInterval((): undefined => undefined, 60_000);
      const polling = spyOn(globalThis, 'setInterval').mockReturnValue(inactivePolling);
      const bound = setTimeout((): void => {
        retired.reject(new Error('Cleanup did not resume after yielding'));
      }, 4_000);
      let worker: PushSender | undefined;
      try {
        const service = aPushService();
        worker = await createPushSender({
          ...world.dependencies(service.post),
          log: {
            ...NO_LOG,
            info: (message, fields): void => {
              if (message === 'pending pushes retired' && typeof fields?.['dropped'] === 'number') {
                dropped += fields['dropped'];
                if (dropped === count) retired.resolve(undefined);
              }
            },
          },
        });
        await retired.promise;
        expect(dropped).toBe(count);
        expect(service.sent).toHaveLength(0);
        expect(world.clock.now()).toEqual(NOW);
        expect(
          await db
            .selectFrom('push_intents')
            .select('id')
            .where('user_id', '=', world.reader)
            .where('expires_at', '<=', NOW)
            .execute(),
        ).toEqual([]);
      } finally {
        clearTimeout(bound);
        try {
          await worker?.flush(10_000);
        } finally {
          clearInterval(inactivePolling);
          polling.mockRestore();
        }
      }
    });
  });
});
