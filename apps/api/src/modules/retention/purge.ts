/**
 * `purge:retention` (D-27 §1, D-139 §1–§3): in each workspace that keeps its history for a number of
 * days, the messages older than that go — hard-deleted, as D-27 says, one by one.
 *
 * - **Each message by its own channel's window**, which is the longer of the workspace's and the
 *   channel's (D-225): a channel that keeps everything loses nothing, and one with a floor of its own
 *   keeps what is inside it. Computed in the batch's own read from the rows as they are, never from a
 *   stored "effective" number, so a workspace window lengthened past a channel's floor wins, and a
 *   setting changed while a night runs is the rule from the next batch on. A workspace that keeps
 *   everything is not read at all: nothing is longer than forever.
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
import {
  sql,
  type DB,
  type Executor,
  type Expression,
  type ExpressionBuilder,
  type SqlBool,
  type Transaction,
} from '@purlay/db';
import { DAY_MS } from '../../platform/clock';
import type { ObjectStore } from '../../platform/storage';
import { atomicallyOn } from '../../platform/transactions';
import { drainObjectDeletions } from '../attachments/deletions';
import { recordAudit } from '../audit/audit';
import type { JobDependencies } from '../jobs/jobs';
import {
  REMOVED_COLUMNS as COLUMNS,
  channelsOf,
  dropFiles,
  lockMemberships,
  takeBackLive,
  tombstoneRows,
  type RemovedRow,
} from '../messages/tombstone';

/** Messages one transaction takes, so a long history is a loop and not one long lock. */
export const PURGE_BATCH = 500;

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

const NOTHING: Batch = {
  cleared: 0,
  deleted: 0,
  tombstoned: 0,
  attachments: 0,
  keys: [],
  last: true,
};

/** The tables a candidate read names: a message as `message`, beside its channel. */
type PurgeTables = DB & { readonly message: DB['messages'] };

/**
 * The message's channel keeps it no longer (D-225): not a channel that keeps everything, and older than
 * the channel's own floor where it has one. Beside `created_at < cutoff` — the workspace's window — this
 * is the longer of the two. Whole days of 86,400 seconds, as `DAY_MS` counts the workspace's: a day of
 * the calendar would move with the session's time zone across a clock change.
 */
const pastChannelWindow =
  (now: Date) =>
  (eb: ExpressionBuilder<PurgeTables, 'channels' | 'message'>): Expression<SqlBool> =>
    eb.and([
      eb('channels.retain_forever', '=', false),
      eb.or([
        eb('channels.min_retention_days', 'is', null),
        eb(
          'message.created_at',
          '<',
          sql<Date>`${now}::timestamptz - channels.min_retention_days * interval '86400 seconds'`,
        ),
      ]),
    ]);

/** One batch of replies older than the window: deleted, and their threads summed again. */
const purgeReplies = async (
  transaction: Transaction,
  now: Date,
  workspaceId: string,
  cutoff: Date,
): Promise<Batch> => {
  const candidates = await transaction
    .selectFrom('messages as message')
    .innerJoin('channels', 'channels.id', 'message.channel_id')
    .select(['message.id', 'message.channel_id', 'message.parent_id'])
    .where('message.workspace_id', '=', workspaceId)
    .where('message.parent_id', 'is not', null)
    .where('message.created_at', '<', cutoff)
    .where(pastChannelWindow(now))
    .orderBy('message.created_at')
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
  const rows: readonly RemovedRow[] =
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
    .selectFrom('messages as message')
    .innerJoin('channels', 'channels.id', 'message.channel_id')
    .select(['message.id', 'message.channel_id'])
    .where('message.workspace_id', '=', workspaceId)
    .where('message.parent_id', 'is', null)
    .where('message.created_at', '<', cutoff)
    .where(pastChannelWindow(now))
    .where((eb) =>
      eb.or([
        eb('message.deleted_at', 'is', null),
        eb.not(
          eb.exists(
            eb
              .selectFrom('messages as reply')
              .select('reply.id')
              .whereRef('reply.parent_id', '=', 'message.id'),
          ),
        ),
        eb.exists(
          eb
            .selectFrom('attachments')
            .select('attachments.id')
            .whereRef('attachments.message_id', '=', 'message.id'),
        ),
      ]),
    )
    .orderBy('message.created_at')
    .limit(PURGE_BATCH)
    .execute();
  if (candidates.length === 0) return NOTHING;
  await lockMemberships(transaction, channelsOf(candidates));
  const rows: readonly RemovedRow[] = await transaction
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
        // The rows are gone for good: only now may their files go. One the store refuses waits, queued
        // in the same transaction, for `sweep:deletions` (D-141).
        done.leftBehind += await drainObjectDeletions(
          { atomically: atomicallyOn(database), storage, log },
          batch.keys,
        );
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
 * when a file the store would not delete was left behind — queued for `sweep:deletions`, but said now.
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
