/**
 * `purge:retention` (D-27 §1, D-139 §1–§3): in each workspace that keeps its history for a number of
 * days, the messages older than that go — hard-deleted, as D-27 says, one by one.
 *
 * - **Replies first.** A reply older than the window is deleted, and its thread's summary — how many
 *   replies, when the last — is counted again from what remains.
 * - **Then the top-level messages.** One older than the window with no reply left is deleted; one that
 *   still holds younger replies becomes a tombstone (its words and files go, the row holds the thread)
 *   and goes the night its last reply does. Nothing newer than the window is touched (I-10).
 * - **What each added is taken back first** (`takeBack`, the delete's own rule), while a read position
 *   on it still exists; their files' bytes come off the workspace's count from the rows the delete
 *   returned, and the files themselves are removed once the rows are gone for good (after commit).
 * - **Locked in the order everything else locks, and never waiting on a message.** The memberships of
 *   the batch's channels first (as a send, a read and a delete take them before a message's row is
 *   touched by a reference), then the messages — and a reply's root — `SKIP LOCKED` (a row's age is
 *   its `created_at`, which nothing changes, so what was old when chosen is old when locked). A send replying to a root that moment either lands first and keeps it, or
 *   finds it gone (`404`); two runs at once take different rows; nothing here waits on a row a reader
 *   or a sender holds, so no cycle can close. Each batch is its own transaction: a backlog is a loop,
 *   and a batch of only busy rows ends the night's loop rather than spinning on it.
 * - **One audit row per workspace, per run** (I-10), with what was cleared, as strings — written when
 *   nothing was, and written when a batch failed, with what had committed and `incomplete`. A workspace
 *   that fails does not stop the others; the run fails after them, naming it. A file the store would
 *   not delete fails the run too: its row is gone, so nobody else would ever try again.
 * - A job has no bus: an open screen keeps a purged message until it reloads (D-139 §3).
 */
import { sql, type Executor, type Transaction } from '@purlay/db';
import { DAY_MS } from '../../platform/clock';
import type { ObjectStore } from '../../platform/storage';
import { atomicallyOn } from '../../platform/transactions';
import { removeLeftovers } from '../attachments/uploads';
import { recordAudit } from '../audit/audit';
import type { JobDependencies } from '../jobs/jobs';
import { takeBack, tombstoneRows, type Counted } from '../messages/tombstone';

/** Messages one transaction takes, so a long history is a loop and not one long lock. */
export const PURGE_BATCH = 500;

interface Row {
  readonly id: string;
  readonly channel_id: string;
  readonly parent_id: string | null;
  readonly sender_id: string | null;
  readonly created_at: Date | string;
  readonly deleted_at: Date | string | null;
}

/** What one batch did, and the files to remove once it has committed. */
interface Batch {
  /** Rows that held words a moment ago: deleted or emptied, not counted again the night they go. */
  readonly cleared: number;
  readonly deleted: number;
  readonly tombstoned: number;
  readonly attachments: number;
  readonly keys: readonly string[];
  /** Nothing more of this kind is waiting tonight: fewer than a batch, or every one of them busy. */
  readonly last: boolean;
}

/** Takes back what the live ones among these added, channel by channel. */
const takeBackLive = async (
  transaction: Transaction,
  now: Date,
  rows: readonly Row[],
): Promise<void> => {
  const byChannel = new Map<string, Counted[]>();
  for (const row of rows) {
    // A deleted message's count was taken back when it was deleted.
    if (row.deleted_at !== null) continue;
    const counted = byChannel.get(row.channel_id) ?? [];
    counted.push({ id: row.id, senderId: row.sender_id, createdAt: new Date(row.created_at) });
    byChannel.set(row.channel_id, counted);
  }
  // In channel order, so two runs at once lock memberships in the same order.
  for (const channelId of [...byChannel.keys()].sort()) {
    await takeBack(transaction, now, channelId, byChannel.get(channelId) ?? []);
  }
};

/** The files of these messages: rows deleted, their bytes off the workspace, their keys returned. */
const dropFiles = async (
  transaction: Transaction,
  workspaceId: string,
  messageIds: readonly string[],
): Promise<{ readonly count: number; readonly keys: readonly string[] }> => {
  if (messageIds.length === 0) return { count: 0, keys: [] };
  const gone = await transaction
    .deleteFrom('attachments')
    .where('message_id', 'in', messageIds)
    .returning(['size_bytes', 'storage_key', 'thumbnail_key'])
    .execute();
  if (gone.length > 0) {
    const bytes = gone.reduce((sum, row) => sum + BigInt(row.size_bytes), 0n);
    await transaction
      .updateTable('workspaces')
      .set({
        storage_used_bytes: sql<string>`greatest(storage_used_bytes - ${bytes.toString()}::bigint, 0)`,
      })
      .where('id', '=', workspaceId)
      .execute();
  }
  return {
    count: gone.length,
    keys: gone.flatMap((row) =>
      row.thumbnail_key === null ? [row.storage_key] : [row.storage_key, row.thumbnail_key],
    ),
  };
};

const COLUMNS = ['id', 'channel_id', 'parent_id', 'sender_id', 'created_at', 'deleted_at'] as const;

const NOTHING: Batch = {
  cleared: 0,
  deleted: 0,
  tombstoned: 0,
  attachments: 0,
  keys: [],
  last: true,
};

/** The memberships of these channels, locked in one order: channel, then person (D-106 §3). */
const lockMemberships = async (
  transaction: Transaction,
  channelIds: readonly string[],
): Promise<void> => {
  if (channelIds.length === 0) return;
  await transaction
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', 'in', channelIds)
    .orderBy('channel_id')
    .orderBy('user_id')
    .forUpdate()
    .execute();
};

const channelsOf = (rows: readonly { readonly channel_id: string }[]): string[] =>
  [...new Set(rows.map((row) => row.channel_id))].sort();

/** One batch of replies older than the window: deleted, and their threads summed again. */
const purgeReplies = async (
  transaction: Transaction,
  now: Date,
  workspaceId: string,
  cutoff: Date,
): Promise<Batch> => {
  const candidates = await transaction
    .selectFrom('messages')
    .select(['id', 'channel_id', 'parent_id'])
    .where('workspace_id', '=', workspaceId)
    .where('parent_id', 'is not', null)
    .where('created_at', '<', cutoff)
    .orderBy('created_at')
    .limit(PURGE_BATCH)
    .execute();
  if (candidates.length === 0) return NOTHING;
  await lockMemberships(transaction, channelsOf(candidates));
  // Each reply's root, which its thread's summary is written to: a root a send holds is left for
  // another night, and its replies with it.
  const roots = [
    ...new Set(candidates.flatMap((row) => (row.parent_id === null ? [] : [row.parent_id]))),
  ].sort();
  const held = new Set(
    (
      await transaction
        .selectFrom('messages')
        .select('id')
        .where('id', 'in', roots)
        .orderBy('id')
        .forNoKeyUpdate()
        .skipLocked()
        .execute()
    ).map((row) => row.id),
  );
  const wanted = candidates.filter((row) => row.parent_id !== null && held.has(row.parent_id));
  const rows: readonly Row[] =
    wanted.length === 0
      ? []
      : await transaction
          .selectFrom('messages')
          .select(COLUMNS)
          .where(
            'id',
            'in',
            wanted.map((row) => row.id),
          )
          .orderBy('id')
          .forUpdate()
          .skipLocked()
          .execute();
  if (rows.length === 0) return NOTHING;
  const ids = rows.map((row) => row.id);
  await takeBackLive(transaction, now, rows);
  const files = await dropFiles(transaction, workspaceId, ids);
  await transaction.deleteFrom('messages').where('id', 'in', ids).execute();
  const touched = [
    ...new Set(rows.flatMap((row) => (row.parent_id === null ? [] : [row.parent_id]))),
  ];
  await sql`
    update messages as root
    set
      (thread_reply_count, thread_last_reply_at) = (
        select count(*), max(reply.created_at) from messages as reply where reply.parent_id = root.id
      ),
      state_version = root.state_version + 1
    where root.id = any(${touched}::uuid[])
  `.execute(transaction);
  // A resolved thread with nothing left in it is not an answered question (I-8): its root goes in
  // this night's second phase, and until then it is not counted resolved.
  await transaction
    .updateTable('messages')
    .set({ resolved_at: null, resolved_by: null })
    .where('id', 'in', touched)
    .where('thread_reply_count', '=', 0)
    .where('resolved_at', 'is not', null)
    .execute();
  return {
    cleared: rows.filter((row) => row.deleted_at === null).length,
    deleted: rows.length,
    tombstoned: 0,
    attachments: files.count,
    keys: files.keys,
    last: candidates.length < PURGE_BATCH,
  };
};

/**
 * One batch of top-level messages older than the window: those with no reply left deleted, those
 * still holding younger replies made tombstones with their files gone. A tombstone already holding a
 * thread, with no file left, is what the night leaves — so it is not taken again, and the loop ends.
 */
const purgeRoots = async (
  transaction: Transaction,
  now: Date,
  workspaceId: string,
  cutoff: Date,
): Promise<Batch> => {
  const candidates = await transaction
    .selectFrom('messages as root')
    .select(['root.id', 'root.channel_id'])
    .where('root.workspace_id', '=', workspaceId)
    .where('root.parent_id', 'is', null)
    .where('root.created_at', '<', cutoff)
    .where((eb) =>
      eb.or([
        eb('root.deleted_at', 'is', null),
        eb.not(
          eb.exists(
            eb
              .selectFrom('messages as reply')
              .select('reply.id')
              .whereRef('reply.parent_id', '=', 'root.id'),
          ),
        ),
        eb.exists(
          eb
            .selectFrom('attachments')
            .select('attachments.id')
            .whereRef('attachments.message_id', '=', 'root.id'),
        ),
      ]),
    )
    .orderBy('root.created_at')
    .limit(PURGE_BATCH)
    .execute();
  if (candidates.length === 0) return NOTHING;
  await lockMemberships(transaction, channelsOf(candidates));
  const rows: readonly Row[] = await transaction
    .selectFrom('messages')
    .select(COLUMNS)
    .where(
      'id',
      'in',
      candidates.map((row) => row.id),
    )
    .orderBy('id')
    .forUpdate()
    .skipLocked()
    .execute();
  if (rows.length === 0) return NOTHING;
  const ids = rows.map((row) => row.id);
  const holding = new Set(
    (
      await transaction
        .selectFrom('messages')
        .select('parent_id')
        .distinct()
        .where('parent_id', 'in', ids)
        .execute()
    ).flatMap((row) => (row.parent_id === null ? [] : [row.parent_id])),
  );
  await takeBackLive(transaction, now, rows);
  const files = await dropFiles(transaction, workspaceId, ids);
  const alone = ids.filter((id) => !holding.has(id));
  if (alone.length > 0) await transaction.deleteFrom('messages').where('id', 'in', alone).execute();
  const kept = await tombstoneRows(
    transaction,
    now,
    rows.filter((row) => holding.has(row.id) && row.deleted_at === null).map((row) => row.id),
  );
  const live = new Set(rows.filter((row) => row.deleted_at === null).map((row) => row.id));
  return {
    cleared: alone.filter((id) => live.has(id)).length + kept.length,
    deleted: alone.length,
    tombstoned: kept.length,
    attachments: files.count,
    keys: files.keys,
    last: candidates.length < PURGE_BATCH,
  };
};

/** What the purge did in one workspace. */
export interface Purged {
  readonly cleared: number;
  readonly deleted: number;
  readonly tombstoned: number;
  readonly attachments: number;
  readonly leftBehind: number;
}

/**
 * One workspace's history past its window, in batches; then its line on the trail — whatever happened,
 * since what committed before a failure is gone and must be said. A failure is thrown on after it.
 */
export const purgeWorkspace = async (
  dependencies: JobDependencies & { readonly storage: ObjectStore },
  workspace: { readonly id: string; readonly retentionDays: number },
): Promise<Purged> => {
  const { database, clock, storage, log } = dependencies;
  const now = clock.now();
  const cutoff = new Date(now.getTime() - workspace.retentionDays * DAY_MS);
  const done = { cleared: 0, deleted: 0, tombstoned: 0, attachments: 0, leftBehind: 0 };
  let failure: unknown = null;
  try {
    for (const phase of [purgeReplies, purgeRoots]) {
      for (;;) {
        const batch = await atomicallyOn(database)(
          async (transaction) => await phase(transaction, now, workspace.id, cutoff),
        );
        done.cleared += batch.cleared;
        done.deleted += batch.deleted;
        done.tombstoned += batch.tombstoned;
        done.attachments += batch.attachments;
        // The rows are gone for good: only now may their files go.
        done.leftBehind += await removeLeftovers(storage, log, batch.keys);
        if (batch.last) break;
      }
    }
  } catch (error) {
    failure = error;
  }
  await atomicallyOn(database)(async (transaction) => {
    await recordAudit(transaction, clock, {
      workspaceId: workspace.id,
      actorUserId: null,
      action: 'retention.purged',
      targetType: 'workspace',
      targetId: workspace.id,
      metadata: {
        days: String(workspace.retentionDays),
        messages: String(done.cleared),
        files: String(done.attachments),
        ...(done.leftBehind === 0 ? {} : { filesLeft: String(done.leftBehind) }),
        ...(failure === null ? {} : { incomplete: 'true' }),
      },
    });
  });
  if (failure !== null) {
    throw failure instanceof Error
      ? failure
      : new Error('the retention purge failed', { cause: failure });
  }
  return done;
};

/**
 * `purge:retention`: every live workspace that keeps its history for a number of days. One that fails
 * does not keep the others from theirs; the run fails after them, naming each that did, and fails too
 * when a file the store would not delete was left behind — nothing would try it again.
 */
export const purgeRetention = async (
  dependencies: JobDependencies & { readonly storage: ObjectStore },
): Promise<{
  workspaces: number;
  cleared: number;
  deleted: number;
  tombstoned: number;
  attachments: number;
  leftBehind: number;
}> => {
  const workspaces = await retainingWorkspaces(dependencies.database);
  const total = {
    workspaces: workspaces.length,
    cleared: 0,
    deleted: 0,
    tombstoned: 0,
    attachments: 0,
    leftBehind: 0,
  };
  const failed: { readonly workspaceId: string; readonly error: unknown }[] = [];
  for (const workspace of workspaces) {
    try {
      const purged = await purgeWorkspace(dependencies, workspace);
      total.cleared += purged.cleared;
      total.deleted += purged.deleted;
      total.tombstoned += purged.tombstoned;
      total.attachments += purged.attachments;
      total.leftBehind += purged.leftBehind;
    } catch (error) {
      failed.push({ workspaceId: workspace.id, error });
    }
  }
  if (failed.length > 0) {
    throw new AggregateError(
      failed.map((failure) => failure.error),
      `the retention purge failed in ${String(failed.length)} workspace(s): ${failed
        .map((failure) => failure.workspaceId)
        .join(', ')}`,
    );
  }
  if (total.leftBehind > 0) {
    throw new Error(
      `the retention purge left ${String(total.leftBehind)} file(s) in storage that it could not delete`,
    );
  }
  return total;
};

const retainingWorkspaces = async (
  database: Executor,
): Promise<readonly { readonly id: string; readonly retentionDays: number }[]> =>
  (
    await database
      .selectFrom('workspaces')
      .select(['id', 'retention_days'])
      .where('retention_days', 'is not', null)
      .where('deleted_at', 'is', null)
      .orderBy('id')
      .execute()
  ).flatMap((row) =>
    row.retention_days === null ? [] : [{ id: row.id, retentionDays: row.retention_days }],
  );
