/** Source writes and account erasure must compose with erasure's session-before-workspace order. */
import { afterAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, closeIntegrationDatabase, sql } from '@purlay/db';
import { messageId } from '@purlay/types';
import { send } from '../../features/chat/messages/messages';
import { chatUserErased } from '../../features/chat/channels/user-hooks';
import { atomicallyOn } from '../../platform/transactions';
import { pendingPush, PUSH_QUIET_BUS } from '../../testing/pending-push';
import { NOW } from '../../testing/doubles';
import { eraseAccount } from '../users/erasure';

afterAll(closeIntegrationDatabase);

describe('integration: producer erasure concurrency', () => {
  test('integration: a source holding its workspace can finish while recipient erasure holds the session', async () => {
    const owned = await cloneIntegrationDatabase();
    const held = Promise.withResolvers<number>();
    const resume = Promise.withResolvers<undefined>();
    const eraser = Promise.withResolvers<number>();
    let finished: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      const world = await pendingPush(owned.db);
      const subscription = await owned.db
        .selectFrom('push_subscriptions')
        .select('session_id')
        .where('user_id', '=', world.reader)
        .executeTakeFirstOrThrow();
      const sending = owned.db.transaction().execute(async (tx) => {
        await sql`set local statement_timeout = '5s'`.execute(tx);
        const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx);
        await tx
          .selectFrom('workspaces')
          .select('id')
          .where('id', '=', world.room.workspaceId)
          .forKeyShare()
          .execute();
        held.resolve(pid.rows[0]!.pid);
        await resume.promise;
        return await send(
          { atomically: atomicallyOn(tx), clock: world.clock, bus: PUSH_QUIET_BUS },
          world.room.members['writer']!.context,
          {
            id: messageId(new Date(NOW.getTime() + 1)),
            content: `@${world.room.members['reader']!.username} a concurrent message`,
          },
        );
      });
      const senderPid = await held.promise;
      const erasing = owned.db.transaction().execute(async (tx) => {
        await sql`set local statement_timeout = '5s'`.execute(tx);
        const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx);
        eraser.resolve(pid.rows[0]!.pid);
        return await eraseAccount(
          tx,
          world.clock,
          { userId: world.reader, sessionId: subscription.session_id },
          world.room.members['reader']!.username,
          chatUserErased(),
        );
      });
      finished = Promise.allSettled([sending, erasing]);
      const eraserPid = await eraser.promise;
      let waiting = false;
      for (let n = 0; n < 200 && !waiting; n++) {
        const result = await sql<{
          waiting: boolean;
        }>`select ${senderPid} = any(pg_blocking_pids(${eraserPid})) as waiting`.execute(owned.db);
        waiting = result.rows[0]?.waiting === true;
        if (!waiting) await Bun.sleep(5);
      }
      expect(waiting).toBe(true);
      resume.resolve(undefined);
      const results = await finished;
      expect(
        results.map((result) =>
          result.status === 'fulfilled' ? result.status : (result.reason as { code?: string }).code,
        ),
      ).toEqual(['fulfilled', 'fulfilled']);
      expect(
        await owned.db
          .selectFrom('push_intents')
          .select('id')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([]);
      expect(
        await owned.db
          .selectFrom('push_subscriptions')
          .select('id')
          .where('user_id', '=', world.reader)
          .execute(),
      ).toEqual([]);
    } finally {
      resume.resolve(undefined);
      await finished;
      await owned.drop();
    }
  }, 30_000);
});
