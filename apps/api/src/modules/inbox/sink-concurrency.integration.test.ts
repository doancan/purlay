/** The real sink and account erasure must use a consistent workspace/user lock order (D-286). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  CLONE_HOOK_MS,
  closeIntegrationDatabase,
  DROP_HOOK_MS,
  sql,
  type DatabasePool,
} from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { NO_LOG, type EventBus } from '../../platform/events';
import { serverMetrics } from '../../platform/metrics';
import { hookList } from '../../platform/hooks';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { NOW } from '../../testing/doubles';
import { aSession } from '../../testing/signed-in';
import { aUniqueSlug, aUserRow } from '../../testing/users';
import { eraseAccount } from '../users/erasure';
import { notificationSink } from './sink';

// This race writes a notice inside its caller transaction; announcements are covered by the sink suite.
const idleBus: EventBus = {
  publish: (): Promise<void> => Promise.resolve(),
  subscribe: () => true,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve: (value: T) => void = (): void => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('integration: notification and account erasure lock ordering', () => {
  let clone: Awaited<ReturnType<typeof cloneIntegrationDatabase>> | undefined;
  beforeAll(async () => {
    clone = await cloneIntegrationDatabase();
  }, CLONE_HOOK_MS);
  afterAll(async () => {
    await clone?.drop();
    await closeIntegrationDatabase();
  }, DROP_HOOK_MS);

  test('a notice and a real erasure both finish when erasure waits on the notice’s recipient lock', async () => {
    const database = clone?.db;
    if (database === undefined) throw new Error('the private database was not created');
    const clock = fixedClock(NOW);
    const world = await database.transaction().execute(async (tx) => {
      const actor = await aUserRow(tx, 'inbox-actor');
      const reader = await aUserRow(tx, 'inbox-reader');
      const workspace = await tx
        .insertInto('workspaces')
        .values({ name: 'Race', slug: aUniqueSlug('inbox-race') })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('workspace_members')
        .values([
          { workspace_id: workspace.id, user_id: actor.userId, role: 'owner' },
          { workspace_id: workspace.id, user_id: reader.userId, role: 'member' },
        ])
        .execute();
      const session = await aSession(tx, clock, reader.userId);
      return {
        reader,
        session,
        context: await requireWorkspaceMembership(tx, actor.userId, workspace.id),
      };
    });
    const held = deferred<undefined>();
    const resume = deferred<undefined>();
    const erasurePid = deferred<number>();
    let noticePid = 0;
    const waiting: Promise<unknown>[] = [];
    const barrier: Parameters<DatabasePool['withPlugin']>[0] = {
      transformQuery: ({ node }): typeof node => node,
      transformResult: async ({ result }): Promise<typeof result> => {
        if (result.rows.some((row) => Object.hasOwn(row, 'user_id'))) {
          held.resolve(undefined);
          await resume.promise;
        }
        return result;
      },
    };
    try {
      const notice = database.transaction().execute(async (tx) => {
        noticePid =
          (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)).rows[0]?.pid ??
          0;
        await sql`set local deadlock_timeout = '100ms'`.execute(tx);
        return await notificationSink({
          clock,
          bus: idleBus,
          log: NO_LOG,
          written: serverMetrics().inboxEntries,
          kinds: new Map([['thing_assigned', 'things']]),
          pushedKinds: new Set(),
        }).notify(tx.withPlugin(barrier), world.context, {
          kind: 'thing_assigned',
          recipientId: world.reader.userId,
          subject: { type: 'thing', id: crypto.randomUUID() },
          params: { title: 'Assignment' },
        });
      });
      waiting.push(notice);
      await Promise.race([held.promise, notice]);
      expect(noticePid).toBeGreaterThan(0);
      const erase = database.transaction().execute(async (tx) => {
        erasurePid.resolve(
          (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)).rows[0]?.pid ??
            0,
        );
        return await eraseAccount(
          tx,
          clock,
          { userId: world.reader.userId, sessionId: world.session.sessionId },
          world.reader.username,
          hookList(),
        );
      });
      waiting.push(erase);
      const pid = await erasurePid.promise;
      expect(pid).toBeGreaterThan(0);
      const deadline = performance.now() + 1_500;
      let blocked = false;
      while (performance.now() < deadline) {
        const row = (
          await sql<{
            blockers: number[];
          }>`select pg_blocking_pids(${pid}::int) as blockers`.execute(database)
        ).rows[0];
        if (row?.blockers.includes(noticePid) === true) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
      resume.resolve(undefined);
      const settled = await Promise.allSettled(waiting);
      expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(
        (
          await database
            .selectFrom('users')
            .select('deleted_at')
            .where('id', '=', world.reader.userId)
            .executeTakeFirstOrThrow()
        ).deleted_at,
      ).toEqual(NOW);
      expect(
        await database
          .selectFrom('inbox_entries')
          .select('id')
          .where('user_id', '=', world.reader.userId)
          .execute(),
      ).toEqual([]);
    } finally {
      resume.resolve(undefined);
      await Promise.allSettled(waiting);
    }
  });
});
