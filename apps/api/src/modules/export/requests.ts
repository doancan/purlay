/**
 * An owner's export (D-140 §1): asked for, made in the background by the API, downloaded once — by the
 * owner who asked, and nobody else.
 *
 * - **Asked for by an owner**, one at a time a workspace (`EXPORT_IN_PROGRESS`, held by a unique index as
 *   well as the check), and answered at once. Made one at a time a process (`exportQueue`): each holds a
 *   snapshot transaction for its reads, and the pool is the chat's first.
 * - **Made from what that owner can see**, by the product's own rule (`visibleChannelIds`), with their
 *   role read again as the making starts: an owner demoted or gone since is not exported for.
 * - **The asker's alone**: the list shows, and the download serves, only the caller's own exports —
 *   another owner's holds conversations they may not see.
 * - **Downloaded once**: the download claims the export in the statement that checks it is ready and
 *   theirs; the archive leaves the store when the download ends — served whole, cut off, or failed —
 *   and the row keeps its key until the object is gone, so the sweep finishes what a refused delete
 *   left.
 * - **Alive while made**: a heartbeat every minute; one silent for `EXPORT_SILENT_MS` was cut off by a
 *   restart, and the sweep marks it failed. However long a large export takes, it is not mistaken for
 *   one cut off; and one marked so meanwhile cannot become ready (its update needs `pending`).
 * - **Failures are codes** (`ExportFailure`), never what a store or a database said; the log has it.
 * - **On the trail twice**: asked for, at once; exported, once it is ready for the owner.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Executor, Transaction } from '@purlay/db';
import {
  EXPORT_KEPT_HOURS,
  ExportFailure,
  Uuid,
  messageId,
  type WorkspaceExport,
} from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import type { Clock } from '../../platform/clock';
import { HOUR_MS } from '../../platform/clock';
import { visibleChannelIds } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import { workspacePrefix, type ObjectStore } from '../../platform/storage';
import type { WorkspaceContext } from '../../platform/tenancy';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { recordAudit } from '../audit/audit';
import { exportWorkspace } from './export';
import { writeTar } from './tar';

/** How often a run says it is alive, and how long silent before the sweep takes it for cut off. */
const HEARTBEAT_MS = 60_000;
const EXPORT_SILENT_MS = 10 * HEARTBEAT_MS;

const ownersOnly = (): AppError =>
  new AppError({ code: 'FORBIDDEN', message: 'Only an owner exports the workspace.' });

const notFound = (): AppError =>
  new AppError({
    code: 'EXPORT_NOT_FOUND',
    message: 'That export is not there to download: it was downloaded already, or expired.',
  });

/** An export's failure as the contract says it: a code it knows, or the export's own. */
const failureOf = (error: unknown): ExportFailure => {
  const code = error instanceof AppError ? error.body.code : 'EXPORT_FAILED';
  return Value.Check(ExportFailure, code) ? code : 'EXPORT_FAILED';
};

interface Row {
  readonly id: string;
  readonly status: string;
  readonly created_at: Date | string;
  readonly finished_at: Date | string | null;
  readonly expires_at: Date | string | null;
  readonly size_bytes: string | null;
  readonly failure: string | null;
}

const COLUMNS = [
  'id',
  'status',
  'created_at',
  'finished_at',
  'expires_at',
  'size_bytes',
  'failure',
] as const;

const STATUSES: readonly WorkspaceExport['status'][] = [
  'pending',
  'ready',
  'failed',
  'downloaded',
  'expired',
];

/** The column's word, as the contract's: the table's check holds the same five. */
const statusOf = (word: string): WorkspaceExport['status'] => {
  const status = STATUSES.find((known) => known === word);
  if (status === undefined) throw new Error(`an export with a status nobody knows: ${word}`);
  return status;
};

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const shown = (row: Row): WorkspaceExport => ({
  id: row.id,
  status: statusOf(row.status),
  createdAt: new Date(row.created_at).toISOString(),
  finishedAt: iso(row.finished_at),
  expiresAt: iso(row.expires_at),
  sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  failure:
    row.failure === null
      ? null
      : Value.Check(ExportFailure, row.failure)
        ? row.failure
        : 'EXPORT_FAILED',
});

/** Where an export's archive is kept: under its workspace, as every key of the store is. */
const keyOf = (workspaceId: string, exportId: string): string =>
  `${workspacePrefix(workspaceId)}exports/${exportId}.tar`;

/** Asks for an export; the caller starts it once this has committed (`exportQueue`). */
export const requestExport = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
): Promise<WorkspaceExport> => {
  if (context.role !== 'owner') throw ownersOnly();
  // The role as it is now, under the workspace's lock, as every owner's write reads it (#527).
  await transaction
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', context.workspaceId)
    .forUpdate()
    .execute();
  const now = await requireWorkspaceMembership(transaction, context.userId, context.workspaceId);
  if (now.role !== 'owner') throw ownersOnly();
  const making = await transaction
    .selectFrom('workspace_exports')
    .select('id')
    .where('workspace_id', '=', context.workspaceId)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  if (making !== undefined) {
    throw new AppError({
      code: 'EXPORT_IN_PROGRESS',
      message: 'An export of this workspace is being made already.',
    });
  }
  const at = clock.now();
  const row = await transaction
    .insertInto('workspace_exports')
    .values({
      id: messageId(at),
      workspace_id: context.workspaceId,
      requested_by: context.userId,
      status: 'pending',
      created_at: at,
      heartbeat_at: at,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  // Asked for is on the trail at once; exported is too, when it is ready.
  await recordAudit(transaction, clock, {
    workspaceId: context.workspaceId,
    actorUserId: context.userId,
    action: 'workspace.export_requested',
    targetType: 'workspace',
    targetId: context.workspaceId,
  });
  return shown(row);
};

/** The caller's own exports of the workspace, newest first: what the owner's dialog shows. */
export const listExports = async (
  executor: Executor,
  context: WorkspaceContext,
): Promise<WorkspaceExport[]> => {
  if (context.role !== 'owner') throw ownersOnly();
  const rows = await executor
    .selectFrom('workspace_exports')
    .select(COLUMNS)
    .where('workspace_id', '=', context.workspaceId)
    .where('requested_by', '=', context.userId)
    .orderBy('id', 'desc')
    .limit(10)
    .execute();
  return rows.map(shown);
};

export interface RunDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly storage: ObjectStore;
}

/** Marks an export failed, with a code; only while it is still being made. */
const fail = async (
  dependencies: RunDependencies,
  exportId: string,
  failure: ExportFailure,
): Promise<void> => {
  await dependencies.database
    .updateTable('workspace_exports')
    .set({ status: 'failed', failure, finished_at: dependencies.clock.now() })
    .where('id', '=', exportId)
    .where('status', '=', 'pending')
    .execute();
};

/**
 * A run being made says so, every `HEARTBEAT_MS`: the sweep takes one silent too long as cut off. A
 * beat that cannot be written is logged and the run goes on — the next beat may land, and a run the
 * sweep does give up on finds its export no longer pending when it ends.
 */
export const sayAlive = async (dependencies: RunDependencies, exportId: string): Promise<void> => {
  try {
    await dependencies.database
      .updateTable('workspace_exports')
      .set({ heartbeat_at: dependencies.clock.now() })
      .where('id', '=', exportId)
      .where('status', '=', 'pending')
      .execute();
  } catch (error) {
    dependencies.log.warn('an export could not say it is alive', { exportId, err: error });
  }
};

/** The asker's membership now, or `null` once they are no member; any other failure is thrown. */
const membershipOf = async (
  database: Executor,
  userId: string,
  workspaceId: string,
): Promise<WorkspaceContext | null> => {
  try {
    return await requireWorkspaceMembership(database, userId, workspaceId);
  } catch (error) {
    if (error instanceof AppError && error.body.code === 'WORKSPACE_NOT_FOUND') return null;
    throw error;
  }
};

/**
 * An archive stored for an export that then failed: it goes. One the store will not let go of is
 * logged — no row names it, so the sweep cannot — for the operator to remove by its key.
 */
const removeArchive = async (
  dependencies: RunDependencies,
  exportId: string,
  key: string,
): Promise<void> => {
  try {
    await dependencies.storage.delete(key);
  } catch (error) {
    dependencies.log.error('a failed export’s archive could not be removed from storage', {
      exportId,
      key,
      err: error,
    });
  }
};

/** Makes one export, start to end. Throws only what it could not record. */
const makeExport = async (dependencies: RunDependencies, exportId: string): Promise<void> => {
  const { database, clock, log, storage } = dependencies;
  const row = await database
    .selectFrom('workspace_exports')
    .innerJoin('workspaces', 'workspaces.id', 'workspace_exports.workspace_id')
    .select([
      'workspace_exports.workspace_id',
      'workspace_exports.requested_by',
      'workspaces.slug',
      'workspaces.name',
    ])
    .where('workspace_exports.id', '=', exportId)
    .where('workspace_exports.status', '=', 'pending')
    .where('workspaces.deleted_at', 'is', null)
    .executeTakeFirst();
  if (row === undefined) {
    log.warn('an export to make is no longer waiting', { exportId });
    await fail(dependencies, exportId, 'EXPORT_FAILED');
    return;
  }
  // The owner as they are now: one demoted, gone, or erased since asking is not exported for.
  const context =
    row.requested_by === null
      ? null
      : await membershipOf(database, row.requested_by, row.workspace_id);
  const live =
    row.requested_by === null
      ? undefined
      : await database
          .selectFrom('users')
          .select('id')
          .where('id', '=', row.requested_by)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
  if (context?.role !== 'owner' || live === undefined) {
    log.warn('an export’s owner is no longer one', { exportId, workspaceId: row.workspace_id });
    await fail(dependencies, exportId, 'EXPORT_REQUESTER_GONE');
    return;
  }
  const owner = context.userId;
  const channelIds = await visibleChannelIds(database, context);

  const beat = setInterval(() => {
    // `sayAlive` never rejects: its own failure is its log line.
    void sayAlive(dependencies, exportId);
  }, HEARTBEAT_MS);
  const scratch = await mkdtemp(join(tmpdir(), 'purlay-export-'));
  const key = keyOf(row.workspace_id, exportId);
  let stored = false;
  try {
    const folder = join(scratch, 'export');
    const { manifest } = await exportWorkspace(
      dependencies,
      { id: row.workspace_id, slug: row.slug, name: row.name },
      { kind: 'visible-to-owner', workspaceId: row.workspace_id, channelIds },
      folder,
      'caller',
    );
    // A short, fixed root inside the archive: the slug is in the download's name, not each entry's.
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
    // Ready and on the trail together: a trail that refuses leaves it pending, to fail below.
    const ready = await atomicallyOn(database)(async (transaction) => {
      const done = clock.now();
      const marked = await transaction
        .updateTable('workspace_exports')
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
      if (marked === undefined) return false;
      await recordAudit(transaction, clock, {
        workspaceId: row.workspace_id,
        actorUserId: owner,
        action: 'workspace.exported',
        targetType: 'workspace',
        targetId: row.workspace_id,
        metadata: {
          scope: 'visible-to-owner',
          messages: String(manifest.tables['messages'] ?? 0),
        },
      });
      return true;
    });
    if (!ready) {
      // Marked cut off meanwhile: the archive is nobody's, and goes.
      await storage.delete(key);
      log.warn('an export finished after it was given up on', { exportId });
      return;
    }
    log.info('export ready', { exportId, workspaceId: row.workspace_id, bytes: size });
  } catch (error) {
    log.error('export failed', { exportId, workspaceId: row.workspace_id, err: error });
    if (stored) await removeArchive(dependencies, exportId, key);
    await fail(dependencies, exportId, failureOf(error));
  } finally {
    clearInterval(beat);
    await rm(scratch, { recursive: true, force: true });
  }
};

/**
 * Makes an export asked for; never throws — what goes wrong is the row's `failure` and the log's line,
 * and a failure even to record that is the sweep's to find.
 */
const runExport = async (dependencies: RunDependencies, exportId: string): Promise<void> => {
  try {
    await makeExport(dependencies, exportId);
  } catch (error) {
    dependencies.log.error('export could not be made or recorded', { exportId, err: error });
  }
};

/**
 * The process's exports, one at a time, in the order asked: each holds a snapshot transaction and a
 * scratch directory while it runs, and the chat comes first. `settled` is what shutdown may wait on.
 */
export const exportQueue = (
  dependencies: RunDependencies,
): { readonly start: (exportId: string) => void; readonly settled: () => Promise<void> } => {
  let tail: Promise<void> = Promise.resolve();
  return {
    start: (exportId): void => {
      tail = tail.then(async () => {
        await runExport(dependencies, exportId);
      });
    },
    settled: async (): Promise<void> => {
      await tail;
    },
  };
};

/**
 * Claims a ready export for its one download, in the statement that checks it is ready, not expired,
 * this workspace's and the caller's own; answers where its archive is. Anything else — an id that is no
 * UUID among it — is the one `EXPORT_NOT_FOUND`.
 */
export const claimDownload = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  exportId: string,
): Promise<{ readonly key: string; readonly size: number }> => {
  if (context.role !== 'owner') throw ownersOnly();
  // An id that is no UUID names no export; asked of a uuid column it would be the database's error.
  if (!Value.Check(Uuid, exportId)) throw notFound();
  const now = clock.now();
  const claimed = await transaction
    .updateTable('workspace_exports')
    .set({ status: 'downloaded', downloaded_at: now })
    .where('id', '=', exportId)
    .where('workspace_id', '=', context.workspaceId)
    .where('requested_by', '=', context.userId)
    .where('status', '=', 'ready')
    .where('expires_at', '>', now)
    .returning(['storage_key', 'size_bytes'])
    .executeTakeFirst();
  if (claimed?.storage_key == null) throw notFound();
  return { key: claimed.storage_key, size: Number(claimed.size_bytes) };
};

/** The archive is gone from the store: the row lets go of its key. */
export const forgetArchive = async (database: Executor, key: string): Promise<void> => {
  await database
    .updateTable('workspace_exports')
    .set({ storage_key: null })
    .where('storage_key', '=', key)
    .where('status', '<>', 'ready')
    .execute();
};

/**
 * `sweep:exports`: ready archives past their expiry claimed as expired — first, so a download cannot
 * claim one being taken — then every archive a row no longer needs (expired, downloaded, failed) taken
 * out of the store, one refusal not stopping the rest; and exports silent too long marked cut off.
 */
export const sweepExports = async (dependencies: {
  readonly database: Executor;
  readonly clock: Clock;
  readonly storage: ObjectStore;
  readonly log: Logger;
}): Promise<{ expired: number; removed: number; leftBehind: number; abandoned: number }> => {
  const { database, clock, storage, log } = dependencies;
  const now = clock.now();
  const expired = await database
    .updateTable('workspace_exports')
    .set({ status: 'expired' })
    .where('status', '=', 'ready')
    .where('expires_at', '<=', now)
    .returning('id')
    .execute();
  const spent = await database
    .selectFrom('workspace_exports')
    .select('storage_key')
    .where('status', '<>', 'ready')
    .where('status', '<>', 'pending')
    .where('storage_key', 'is not', null)
    .execute();
  let removed = 0;
  let leftBehind = 0;
  for (const { storage_key: key } of spent) {
    if (key === null) continue;
    try {
      await storage.delete(key);
      await forgetArchive(database, key);
      removed += 1;
    } catch (error) {
      leftBehind += 1;
      log.error('an export’s archive could not be removed from storage', { err: error });
    }
  }
  const abandoned = await database
    .updateTable('workspace_exports')
    .set({ status: 'failed', failure: 'EXPORT_ABANDONED', finished_at: now })
    .where('status', '=', 'pending')
    .where('heartbeat_at', '<', new Date(now.getTime() - EXPORT_SILENT_MS))
    .returning('id')
    .execute();
  if (leftBehind > 0) {
    throw new Error(`${String(leftBehind)} export archive(s) could not be removed from storage`);
  }
  return { expired: expired.length, removed, leftBehind, abandoned: abandoned.length };
};
