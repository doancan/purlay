/**
 * `purge:workspaces` (D-242): each workspace whose deletion was asked for more than the grace period ago is
 * claimed, then emptied — its messages and their files, its unsent uploads, its exports, its channels, and
 * last everything else that names it, its memberships the very last. The row stays, a tombstone with its
 * name, for the trails that refer to it (I-9); the server's trail gets one line, `server.workspace_purged`.
 *
 * - **Claimed under the row's lock**, which taking the deletion back waits on too: whichever commits first
 *   wins, and once claimed it can no longer be taken back (`WORKSPACE_DELETION_STARTED`).
 * - **In bounded batches**, each its own transaction, so a large workspace is a loop and not one long lock:
 *   messages replies first (a root is held by its replies, `ON DELETE RESTRICT`), then the roots, by the
 *   workspace's own index; then uploads nobody sent, and channels, a batch at a time.
 * - **Safe to run again**, after a crash or beside another run: every step deletes what is still there,
 *   and the last — memberships, the purged mark and the server's line — is one transaction that only the
 *   first run to reach it does anything in. A claimed workspace not yet purged is taken up by the next run.
 * - **Files leave the store after their rows**: each batch queues their keys in its own transaction and
 *   drains them after the commit; a key the store refuses waits for `sweep:deletions` (D-141), and fails
 *   this run so it is said.
 * - **Nothing is taken back or told**: nobody can reach the workspace (the tenancy guard refuses it since the
 *   deletion was asked for, and its sockets were told then), so no counter needs keeping and no lock order
 *   needs sharing with a writer — there is none.
 */
import { absentTables, type Database, type Executor, type Transaction } from '@purlay/db';
import { WORKSPACE_DELETION_GRACE_DAYS } from '@purlay/types';
import { DAY_MS } from '../../platform/clock';
import type { ObjectStore } from '../../platform/storage';
import { atomicallyOn } from '../../platform/transactions';
import { drainObjectDeletions, enqueueObjectDeletions } from '../attachments/deletions';
import { recordServerAudit } from '../audit/server-audit';
import type { JobDependencies } from '../jobs/jobs';

/** Messages or uploads one transaction takes. Chat's steps are batched by it too. */
export const WORKSPACE_PURGE_BATCH = 500;
/**
 * What still names the workspace once its content, uploads, exports and structure are gone, emptied in this
 * order. The core's own are here; a module adds the tables it owns through the `WorkspacePurge` it is given.
 * Most are empty by then — what named a message or a channel went with it — and are listed so that nothing is
 * left by an order nobody foresaw. `workspace-purge.integration.test.ts` holds both lists, with the steps and
 * the trail kept, to every table the catalogue says refers to a workspace.
 */
export const CORE_REMAINING_TABLES = [
  'inbox_entries',
  'workspace_invitation_mail_attempts',
  'workspace_invitation_recipients',
  'workspace_invitations',
] as const;

/** A table with a `workspace_id` to empty it by. */
type WorkspaceTable = {
  [Table in keyof Database]: 'workspace_id' extends keyof Database[Table] ? Table : never;
}[keyof Database];

/** A step of the purge: a batch until one comes back short. */
interface PurgeStep {
  readonly batch: (transaction: Transaction, workspaceId: string) => Promise<Batch>;
  readonly size: number;
  /** Whether the rows it takes are messages, which the purge counts. */
  readonly messages: boolean;
}

/**
 * What a module adds to the purge of a workspace (D-250): steps before the core's uploads and exports, steps
 * after them, and the tables it owns that name a workspace. The core owns the order and the transaction of each
 * batch, the drain of the keys, the claim, and the last transaction; it names no module's table.
 */
export interface WorkspacePurge {
  readonly before: readonly PurgeStep[];
  readonly after: readonly PurgeStep[];
  readonly tables: readonly WorkspaceTable[];
}

/** One batch's work, and the keys to drain once it has committed. */
export interface Batch {
  readonly rows: number;
  readonly files: number;
  readonly keys: readonly string[];
}

const keysOf = (
  rows: readonly { readonly storage_key: string | null; readonly thumbnail_key?: string | null }[],
): string[] =>
  rows.flatMap((row) =>
    [row.storage_key, row.thumbnail_key ?? null].filter((key): key is string => key !== null),
  );

/** A batch of uploads nobody sent: once the messages are gone, every file left is one. */
const uploadBatch = async (transaction: Transaction, workspaceId: string): Promise<Batch> => {
  const gone = await transaction
    .deleteFrom('attachments')
    .where(
      'id',
      'in',
      transaction
        .selectFrom('attachments')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .limit(WORKSPACE_PURGE_BATCH),
    )
    .returning(['storage_key', 'thumbnail_key'])
    .execute();
  const keys = keysOf(gone);
  await enqueueObjectDeletions(transaction, keys);
  return { rows: gone.length, files: gone.length, keys };
};

/**
 * The workspace's exports, and the archives they name (D-140). An export being made at this moment finds
 * its row gone when it would mark it ready, and removes its own archive.
 */
const exportBatch = async (transaction: Transaction, workspaceId: string): Promise<Batch> => {
  const gone = await transaction
    .deleteFrom('workspace_exports')
    .where('workspace_id', '=', workspaceId)
    .returning('storage_key')
    .execute();
  const keys = keysOf(gone);
  await enqueueObjectDeletions(transaction, keys);
  return { rows: gone.length, files: keys.length, keys };
};

/** What the erasure of one workspace did. */
export interface PurgedWorkspace {
  readonly messages: number;
  readonly files: number;
  readonly leftBehind: number;
}

/**
 * One claimed workspace, emptied. Each step loops until a batch comes back short; the last transaction
 * marks it purged and writes the server's line, and does neither if another run already has.
 */
export const purgeWorkspaceContent = async (
  dependencies: JobDependencies & { readonly storage: ObjectStore },
  workspaceId: string,
  purge: WorkspacePurge,
): Promise<PurgedWorkspace> => {
  const { database, clock, storage, log } = dependencies;
  const done = { messages: 0, files: 0, leftBehind: 0 };
  const steps: readonly PurgeStep[] = [
    ...purge.before,
    { batch: uploadBatch, size: WORKSPACE_PURGE_BATCH, messages: false },
    { batch: exportBatch, size: Number.POSITIVE_INFINITY, messages: false },
    ...purge.after,
  ];
  for (const step of steps) {
    for (;;) {
      const batch = await atomicallyOn(database)(
        async (transaction) => await step.batch(transaction, workspaceId),
      );
      if (step.messages) done.messages += batch.rows;
      done.files += batch.files;
      done.leftBehind += await drainObjectDeletions(
        { atomically: atomicallyOn(database), storage, log },
        batch.keys,
      );
      if (batch.rows < step.size) break;
    }
  }
  await atomicallyOn(database)(async (transaction) => {
    const marked = await transaction
      .updateTable('workspaces')
      .set({ purged_at: clock.now(), storage_used_bytes: '0' })
      .where('id', '=', workspaceId)
      .where('purged_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (marked === undefined) return;
    const named = [...purge.tables, ...CORE_REMAINING_TABLES];
    // A module's own migration set makes some of its tables: a database migrated without it has none to empty.
    const absent = await absentTables(transaction, named);
    for (const table of named.filter((name) => !absent.includes(name))) {
      await transaction.deleteFrom(table).where('workspace_id', '=', workspaceId).execute();
    }
    // Its people last: they were told it went when it was asked for, and their sessions stay — they may
    // be in other workspaces.
    await transaction
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', workspaceId)
      .execute();
    await recordServerAudit(transaction, clock, {
      actorUserId: null,
      action: 'server.workspace_purged',
      targetWorkspaceId: workspaceId,
    });
  });
  return done;
};

/**
 * Claims every workspace whose grace period is over: one statement, each row under its lock, so a
 * cancellation that committed first leaves its workspace unclaimed, and one waiting finds it claimed.
 */
const claimDue = async (database: Executor, now: Date): Promise<void> => {
  await database
    .updateTable('workspaces')
    .set({ purge_started_at: now })
    .where('deleted_at', '<=', new Date(now.getTime() - WORKSPACE_DELETION_GRACE_DAYS * DAY_MS))
    .where('purge_started_at', 'is', null)
    .execute();
};

/**
 * `purge:workspaces`: claims what is due, then empties each claimed workspace not yet purged — this run's
 * and any a previous run left. One that fails does not keep the others from theirs; the run fails after
 * them, naming each, and fails too when a file the store would not delete was left behind.
 */
export const purgeWorkspaces = async (
  dependencies: JobDependencies & { readonly storage: ObjectStore },
  purge: WorkspacePurge,
): Promise<{ workspaces: number; messages: number; files: number; leftBehind: number }> => {
  const { database, clock } = dependencies;
  await claimDue(database, clock.now());
  const claimed = await database
    .selectFrom('workspaces')
    .select('id')
    .where('purge_started_at', 'is not', null)
    .where('purged_at', 'is', null)
    .orderBy('id')
    .execute();
  const total = { workspaces: claimed.length, messages: 0, files: 0, leftBehind: 0 };
  const failed: { readonly workspaceId: string; readonly error: unknown }[] = [];
  for (const { id } of claimed) {
    try {
      const purged = await purgeWorkspaceContent(dependencies, id, purge);
      total.messages += purged.messages;
      total.files += purged.files;
      total.leftBehind += purged.leftBehind;
    } catch (error) {
      failed.push({ workspaceId: id, error });
    }
  }
  if (failed.length > 0) {
    throw new AggregateError(
      failed.map((failure) => failure.error),
      `the workspace purge failed in ${String(failed.length)} workspace(s): ${failed
        .map((failure) => failure.workspaceId)
        .join(', ')}`,
    );
  }
  if (total.leftBehind > 0) {
    throw new Error(
      `the workspace purge left ${String(total.leftBehind)} file(s) in storage that it could not delete`,
    );
  }
  return total;
};
