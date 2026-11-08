/**
 * What a fact does when its consumer is stopped by the administrator (D-296, D-288): the publish follows the fact's own `absent` word
 * as for a module this process does not run, a row written earlier is not claimed while the stop lasts and is, whole, once it
 * is lifted. Real PostgreSQL; the rows are read back by what the table holds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  withRollback,
  type ClonedDatabase,
  type Executor,
} from '@purlay/db';
import { aMovableClock, NOW } from '../testing/doubles';
import {
  aPublishWorld,
  aWorkspaceRow,
  NOTE_CREATED,
  NOTE_PINNED,
  NOTES,
  WIKI,
} from '../testing/facts';
import { DAY_MS } from './clock';
import { effectiveModules, type EntitlementPolicy } from './module-kit/entitlement';
import { claimDue } from './outbox-drain';
import { publishFact } from './outbox';
import { readSuspended, withoutStopped } from './suspended-modules';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

const clock = aMovableClock(NOW);

const stop = async (db: Executor, module: string): Promise<void> => {
  await db
    .insertInto('suspended_modules')
    .values({ module, reason: 'test', source: 'test', suspended_at: NOW })
    .execute();
};

/** What a promise was refused with, or `undefined` when it was not. */
const refusalOf = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const rowsOf = async (db: Executor, workspaceId: string): Promise<Record<string, unknown>[]> =>
  await db.selectFrom('outbox').selectAll().where('workspace_id', '=', workspaceId).execute();

describe('integration: the stopped modules are read from the table', () => {
  test('are exactly the rows, and none where the table is empty', async () => {
    await withRollback(async (tx) => {
      expect((await readSuspended(tx)).size).toBe(0);
      await stop(tx, 'issues');
      await stop(tx, 'chat');
      expect([...(await readSuspended(tx))].sort()).toEqual(['chat', 'issues']);
    }, cloned.db);
  });

  test('cannot name something that is not a module id, or give no reason', async () => {
    await withRollback(async (tx) => {
      expect(await refusalOf(stop(tx, 'Not A Module'))).toBeInstanceOf(Error);
    }, cloned.db);
    await withRollback(async (tx) => {
      const refused = await refusalOf(
        tx
          .insertInto('suspended_modules')
          .values({ module: 'issues', reason: '', source: 'test', suspended_at: NOW })
          .execute(),
      );
      expect(refused).toBeInstanceOf(Error);
    }, cloned.db);
  });
});

describe('integration: a fact for a consumer the administrator has stopped', () => {
  test('is dropped and counted when the fact says drop, and held for the days it says when it says holdDays', async () => {
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      const { context, droppedCount } = aPublishWorld(workspaceId, clock);
      const stopped = withoutStopped(context.routing, () => new Set(['wiki']));
      await publishFact(tx, { ...context, routing: stopped }, NOTE_CREATED, {
        noteId: 'n1',
        title: 'Plan',
      });
      await publishFact(tx, { ...context, routing: stopped }, NOTE_PINNED, { noteId: 'n1' });
      const rows = await rowsOf(tx, workspaceId);
      // `shelf` still hears of the created note; `wiki` hears of nothing it drops, and has the pin held for it.
      expect(rows.map((row) => `${String(row['consumer'])} ${String(row['type'])}`).sort()).toEqual(
        ['shelf notes.created', 'wiki notes.pinned'],
      );
      const held = rows.find((row) => row['consumer'] === 'wiki');
      expect((held?.['expires_at'] as Date).getTime()).toBe(NOW.getTime() + 3 * DAY_MS);
      expect(droppedCount('wiki')).toBe(1);
    }, cloned.db);
  });

  test('is not claimed while the stop lasts, and is claimed whole once it is lifted', async () => {
    await withRollback(async (tx) => {
      const workspaceId = await aWorkspaceRow(tx);
      const { context } = aPublishWorld(workspaceId, clock);
      await publishFact(tx, context, NOTE_PINNED, { noteId: 'n1' });
      const handles = [{ consumer: 'wiki', type: 'notes.pinned', shape: 1 }];
      const effective =
        (stopped: ReadonlySet<string>): EntitlementPolicy['effective'] =>
        (rows, now) =>
          effectiveModules({ running: [NOTES, WIKI], rows, mode: 'open', now, suspended: stopped });

      const during = await claimDue(tx, {
        handles,
        batch: 10,
        clock,
        effective: effective(new Set(['wiki'])),
      });
      expect(during.claimed).toEqual([]);
      const untouched = await rowsOf(tx, workspaceId);
      expect(untouched.map((row) => [row['state'], row['attempts']])).toEqual([['pending', 0]]);

      const after = await claimDue(tx, {
        handles,
        batch: 10,
        clock,
        effective: effective(new Set()),
      });
      expect(after.claimed.map((one) => one.consumer)).toEqual(['wiki']);
    }, cloned.db);
  });
});
