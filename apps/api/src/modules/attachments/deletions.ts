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

/**
 * How long an upload's keys, written before its object, wait before the sweep may take them (#607):
 * far longer than any upload takes from the store's write to the row's insert, so an upload on its
 * way never has its object deleted under it.
 */
const UPLOAD_GRACE = sql<Date>`now() + interval '1 hour'`;

/**
 * Before an upload writes its objects (#607): their keys, due only after the grace, so a process that
 * stops before the row is inserted leaves them for the sweep rather than unnamed. The insert takes
 * them out again (`claimUploadKeys`).
 */
export const writeUploadKeysAhead = async (
  transaction: Transaction,
  keys: readonly string[],
): Promise<void> => {
  await transaction
    .insertInto('object_deletions')
    .values(keys.map((key) => ({ storage_key: key, due_at: UPLOAD_GRACE })))
    .onConflict((conflict) => conflict.column('storage_key').doNothing())
    .execute();
};

/** The upload's row names its objects now: their keys leave the queue, in the insert's transaction. */
export const claimUploadKeys = async (
  transaction: Transaction,
  keys: readonly string[],
): Promise<void> => {
  await transaction.deleteFrom('object_deletions').where('storage_key', 'in', keys).execute();
};

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
      // An upload's keys only once its grace has passed: it may still be on its way.
      .where('due_at', '<=', sql<Date>`now()`)
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
