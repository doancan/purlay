/**
 * The stopped modules as the table holds them (D-296): read as exactly its rows, and a row that names no module or gives no reason is
 * refused by the table itself. Real PostgreSQL.
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
import { NOW } from '../testing/doubles';
import { readSuspended } from './suspended-modules';

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

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
