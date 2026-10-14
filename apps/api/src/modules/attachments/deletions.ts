/**
 * Objects whose rows are gone, until the store has let them go (#592, D-141).
 *
 * A row naming an object is deleted in a transaction that also writes the object's key here
 * (`enqueueObjectDeletions`); after the commit the object is deleted and its key with it
 * (`drainObjectDeletions`). A key the store refused, or one whose process stopped before the delete,
 * stays — logged — for `sweep:deletions` to try again, until the store accepts. So a file a retention
 * window or an erasure removed is never kept by forgetting it (D-27).
 */
import { sql, type Executor, type Transaction } from '@purlay/db';
import type { Logger } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import type { Atomically } from '../../platform/transactions';

/** How many keys the sweep reads at a time. */
const DELETION_BATCH = 500;

/** Writes the keys of objects whose rows this transaction deletes. A key already waiting stays. */
export const enqueueObjectDeletions = async (
  transaction: Transaction,
  keys: readonly string[],
): Promise<void> => {
  if (keys.length === 0) return;
  await transaction
    .insertInto('object_deletions')
    .values(keys.map((key) => ({ storage_key: key })))
    .onConflict((conflict) => conflict.column('storage_key').doNothing())
    .execute();
};

export interface DrainDependencies {
  readonly atomically: Atomically;
  readonly storage: ObjectStore;
  readonly log: Logger;
}

/**
 * Deletes these waiting objects; each the store accepts leaves the queue, each it refuses is logged
 * and stays, its attempt counted. Answers how many were left.
 */
export const drainObjectDeletions = async (
  dependencies: DrainDependencies,
  keys: readonly string[],
): Promise<number> => {
  const { atomically, storage, log } = dependencies;
  const deleted: string[] = [];
  const refused: string[] = [];
  for (const key of keys) {
    try {
      await storage.delete(key);
      deleted.push(key);
    } catch (error) {
      refused.push(key);
      log.error('an object could not be deleted from storage; it waits to be tried again', {
        key,
        err: error,
      });
    }
  }
  await atomically(async (transaction) => {
    if (deleted.length > 0) {
      await transaction
        .deleteFrom('object_deletions')
        .where('storage_key', 'in', deleted)
        .execute();
    }
    if (refused.length > 0) {
      await transaction
        .updateTable('object_deletions')
        .set((eb) => ({ attempts: eb('attempts', '+', 1), last_attempt_at: sql<Date>`now()` }))
        .where('storage_key', 'in', refused)
        .execute();
    }
  });
  return refused.length;
};

/**
 * `sweep:deletions`: every waiting object tried again, in key order from where it got to — so keys the
 * store keeps refusing never hold back the ones after them. Throws while any is left, so the run is a
 * failure `jobs:status` reports.
 */
export const sweepObjectDeletions = async (
  dependencies: DrainDependencies & { readonly database: Executor },
): Promise<{ readonly removed: number }> => {
  const { database } = dependencies;
  let removed = 0;
  let left = 0;
  let after = '';
  for (;;) {
    const batch = await database
      .selectFrom('object_deletions')
      .select('storage_key')
      .where('storage_key', '>', after)
      .orderBy('storage_key')
      .limit(DELETION_BATCH)
      .execute();
    const keys = batch.map((row) => row.storage_key);
    const refused = await drainObjectDeletions(dependencies, keys);
    removed += keys.length - refused;
    left += refused;
    const last = keys.at(-1);
    if (last === undefined || keys.length < DELETION_BATCH) break;
    after = last;
  }
  if (left > 0) throw new Error(`${String(left)} object(s) could not be deleted from storage`);
  return { removed };
};
