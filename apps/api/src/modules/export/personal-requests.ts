/**
 * A person's export of their own data (D-241), asked for from their account: made in the background by
 * the API, as an owner's export is (D-140), and downloaded once — by that person, and nobody else.
 *
 * - **The caller's own, always.** Every statement is bound to the session's person; there is no id of
 *   anybody else to name, so another person's export is not there — `EXPORT_NOT_FOUND`, as one that was
 *   downloaded or expired.
 * - **One at a time a person** (`EXPORT_IN_PROGRESS`), checked under the person's row lock and held by a
 *   unique index besides; and at most `PERSONAL_EXPORTS_PER_DAY` asked for in any 24 hours
 *   (`RATE_LIMITED`, with when the next may be asked): each reads everything they ever wrote.
 * - **A live account's alone.** The making reads the account again as it starts: one suspended or erased
 *   since asking is not exported for — nobody could download it, and an archive of a person nobody
 *   watches is the risk. A suspended account has no session to ask with (D-233).
 * - **On the server's trail** (`account.export_requested`, `account.export_downloaded`): the operator
 *   answers a person's access request (D-28), so the record that one was asked for and taken is theirs.
 * - The life it shares with an owner's export — alive, failing, the sweep — is `requests.ts`'s.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor, Transaction } from '@purlay/db';
import {
  EXPORT_KEPT_HOURS,
  PERSONAL_EXPORTS_PER_DAY,
  Uuid,
  messageId,
  type WorkspaceExport,
} from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import type { Clock } from '../../platform/clock';
import { HOUR_MS } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { personPrefix } from '../../platform/storage';
import { recordServerAudit } from '../audit/server-audit';
import { exportPerson } from './personal';
import {
  COLUMNS,
  beatWhileMade,
  fail,
  failureOf,
  notFound,
  removeArchive,
  shown,
  type RunDependencies,
} from './requests';
import { writeTar } from './tar';

/** The window `PERSONAL_EXPORTS_PER_DAY` counts in. */
const DAY_MS = 24 * HOUR_MS;

/** Where a person's archive is kept: under the person, never a workspace (`personPrefix`). */
const keyOf = (userId: string, exportId: string): string =>
  `${personPrefix(userId)}exports/${exportId}.tar`;

/** Asks for an export of the caller's own data; the caller starts it once this has committed. */
export const requestPersonalExport = async (
  transaction: Transaction,
  clock: Clock,
  userId: string,
): Promise<WorkspaceExport> => {
  // The person's row, held: two asks at once are one after the other, and the second sees the first.
  // `no key update`, so their own messages and reactions, which name the row, are not held up.
  const person = await transaction
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .where('suspended_at', 'is', null)
    .forNoKeyUpdate()
    .executeTakeFirst();
  // A session resolves only for a live account (D-233, D-139 §5): this one went while the request ran.
  if (person === undefined)
    throw new AppError({ code: 'UNAUTHENTICATED', message: 'Sign in first.' });
  const making = await transaction
    .selectFrom('personal_exports')
    .select('id')
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (making !== undefined) {
    throw new AppError({
      code: 'EXPORT_IN_PROGRESS',
      message: 'An export of your data is being made already.',
    });
  }
  const at = clock.now();
  const recent = await transaction
    .selectFrom('personal_exports')
    .select('created_at')
    .where('user_id', '=', userId)
    .where('created_at', '>', new Date(at.getTime() - DAY_MS))
    .orderBy('created_at')
    .execute();
  const oldest = recent[0];
  if (recent.length >= PERSONAL_EXPORTS_PER_DAY && oldest !== undefined) {
    const freesAt = new Date(oldest.created_at).getTime() + DAY_MS;
    throw new AppError(
      {
        code: 'RATE_LIMITED',
        message: `You can ask for ${String(PERSONAL_EXPORTS_PER_DAY)} exports of your data a day.`,
      },
      { retryAfterSeconds: Math.max(1, Math.ceil((freesAt - at.getTime()) / 1000)) },
    );
  }
  const row = await transaction
    .insertInto('personal_exports')
    .values({
      id: messageId(at),
      user_id: userId,
      status: 'pending',
      created_at: at,
      heartbeat_at: at,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  await recordServerAudit(transaction, clock, {
    actorUserId: userId,
    action: 'account.export_requested',
    targetUserId: userId,
  });
  return shown(row);
};

/** The caller's own exports of their data, newest first: what their account's card shows. */
export const listPersonalExports = async (
  executor: Executor,
  userId: string,
): Promise<WorkspaceExport[]> => {
  const rows = await executor
    .selectFrom('personal_exports')
    .select(COLUMNS)
    .where('user_id', '=', userId)
    .orderBy('id', 'desc')
    .limit(10)
    .execute();
  return rows.map(shown);
};

/** Makes one export, start to end. Throws only what it could not record. */
const makePersonalExport = async (
  dependencies: RunDependencies,
  exportId: string,
): Promise<void> => {
  const { database, clock, log, storage } = dependencies;
  const row = await database
    .selectFrom('personal_exports')
    .innerJoin('users', 'users.id', 'personal_exports.user_id')
    .select([
      'personal_exports.user_id',
      'users.username',
      'users.deleted_at',
      'users.suspended_at',
    ])
    .where('personal_exports.id', '=', exportId)
    .where('personal_exports.status', '=', 'pending')
    .executeTakeFirst();
  if (row === undefined) {
    log.warn('an export to make is no longer waiting', { exportId });
    return;
  }
  // The account as it is now: suspended or erased since asking, nobody is to receive it.
  if (row.deleted_at !== null || row.suspended_at !== null) {
    log.warn('a person’s export is for an account no longer in use', { exportId });
    await fail(dependencies, 'personal_exports', exportId, 'EXPORT_REQUESTER_GONE');
    return;
  }
  const userId = row.user_id;

  const stopBeating = beatWhileMade(dependencies, 'personal_exports', exportId);
  const scratch = await mkdtemp(join(tmpdir(), 'purlay-export-'));
  const key = keyOf(userId, exportId);
  let stored = false;
  try {
    const folder = join(scratch, 'export');
    await exportPerson(dependencies, { id: userId, username: row.username }, folder);
    const archive = join(scratch, 'export.tar');
    const size = await writeTar(
      folder,
      'export',
      archive,
      Math.floor(clock.now().getTime() / 1000),
    );
    await rm(folder, { recursive: true, force: true });
    await storage.putFile(key, archive, 'application/x-tar');
    stored = true;
    const done = clock.now();
    const marked = await database
      .updateTable('personal_exports')
      .set({
        status: 'ready',
        storage_key: key,
        size_bytes: String(size),
        finished_at: done,
        expires_at: new Date(done.getTime() + EXPORT_KEPT_HOURS * HOUR_MS),
      })
      .where('id', '=', exportId)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    if (marked === undefined) {
      // Marked cut off, or the account erased, meanwhile: the archive is nobody's, and goes — and one the
      // store will not let go of is logged by its key, since no row names it for the sweep.
      await removeArchive(dependencies, exportId, key);
      log.warn('an export finished after it was given up on', { exportId });
      return;
    }
    log.info('a person’s export ready', { exportId, bytes: size });
  } catch (error) {
    log.error('a person’s export failed', { exportId, err: error });
    if (stored) await removeArchive(dependencies, exportId, key);
    await fail(dependencies, 'personal_exports', exportId, failureOf(error));
  } finally {
    stopBeating();
    await rm(scratch, { recursive: true, force: true });
  }
};

/**
 * Makes an export asked for; never throws — what goes wrong is the row's `failure` and the log's line,
 * and a failure even to record that is the sweep's to find.
 */
export const runPersonalExport = async (
  dependencies: RunDependencies,
  exportId: string,
): Promise<void> => {
  try {
    await makePersonalExport(dependencies, exportId);
  } catch (error) {
    dependencies.log.error('a person’s export could not be made or recorded', {
      exportId,
      err: error,
    });
  }
};

/**
 * Claims the caller's ready export for its one download, in the statement that checks it is ready, not
 * expired and theirs, and puts it on the server's trail in the same transaction; answers where its
 * archive is. Anything else — an id that is no UUID among it — is the one `EXPORT_NOT_FOUND`.
 */
export const claimPersonalDownload = async (
  transaction: Transaction,
  clock: Clock,
  userId: string,
  exportId: string,
): Promise<{ readonly key: string; readonly size: number }> => {
  if (!Value.Check(Uuid, exportId)) throw notFound();
  // The person's row before their export's, as erasure takes them (`erasure.ts`): the trail's line below
  // names the row, and taken in the other order a download and an erasure would each wait for the other.
  const person = await transaction
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('deleted_at', 'is', null)
    .forKeyShare()
    .executeTakeFirst();
  if (person === undefined) throw notFound();
  const now = clock.now();
  const claimed = await transaction
    .updateTable('personal_exports')
    .set({ status: 'downloaded', downloaded_at: now })
    .where('id', '=', exportId)
    .where('user_id', '=', userId)
    .where('status', '=', 'ready')
    .where('expires_at', '>', now)
    .returning(['storage_key', 'size_bytes'])
    .executeTakeFirst();
  if (claimed?.storage_key == null) throw notFound();
  await recordServerAudit(transaction, clock, {
    actorUserId: userId,
    action: 'account.export_downloaded',
    targetUserId: userId,
  });
  return { key: claimed.storage_key, size: Number(claimed.size_bytes) };
};

/**
 * On erasure (D-139 §5), in its transaction: a ready export can no longer be downloaded (`expired`), and
 * one being made is given up (`EXPORT_REQUESTER_GONE`) — its run finds it no longer pending and lets its
 * archive go itself. The rows keep their keys, so `sweep:exports` takes the archives out of the store
 * within the hour, as it takes every archive a row no longer needs (D-141 §4): a copy of what they
 * wrote does not outlive the account that asked for it.
 */
export const endPersonalExports = async (
  transaction: Transaction,
  clock: Clock,
  userId: string,
): Promise<void> => {
  await transaction
    .updateTable('personal_exports')
    .set({ status: 'expired' })
    .where('user_id', '=', userId)
    .where('status', '=', 'ready')
    .execute();
  await transaction
    .updateTable('personal_exports')
    .set({ status: 'failed', failure: 'EXPORT_REQUESTER_GONE', finished_at: clock.now() })
    .where('user_id', '=', userId)
    .where('status', '=', 'pending')
    .execute();
};
