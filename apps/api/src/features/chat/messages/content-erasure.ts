/**
 * Content erasure (D-27 §2, D-139 §7): an operator's act, for the cases where anonymised authorship is
 * not enough — every message a person wrote in a workspace becomes a tombstone, as a delete makes one
 * (D-9), and their files go with their objects and their bytes. Events nobody wrote, and the writing an
 * incident keeps (D-137 §3), are untouched; so is everything the account erasure keeps.
 *
 * Scoped to workspaces by the caller: in the cloud each workspace's customer is the controller (D-28),
 * so one request never reaches another's data; a self-hoster who controls them all says so.
 *
 * Batches, as the retention purge's are, in the same lock order — the batch's memberships, then its
 * messages `SKIP LOCKED` — with what each message added taken back first by the delete's own rule. A
 * process with no bus tells no socket: an open screen keeps the words until it reloads (D-139 §7).
 */
import { sql, tableExists } from '@purlay/db';
import type { ChatDb, ChatTx } from '../schema';
import type { ObjectStore } from '../../../platform/storage';
import { atomicallyOn } from '../../../platform/transactions';
import { drainObjectDeletions } from '../../../modules/attachments/deletions';
import { dropMessageFiles } from './message-files';
import { recordAudit } from '../../../modules/audit/audit';
import type { JobDependencies } from '../../../modules/jobs/jobs';
import {
  REMOVED_COLUMNS,
  channelsOf,
  lockMemberships,
  takeBackLive,
  tombstoneRows,
} from './tombstone';

/** Messages one transaction takes. */
const ERASURE_BATCH = 500;

interface Batch {
  readonly emptied: number;
  readonly files: number;
  readonly keys: readonly string[];
  readonly last: boolean;
  /** Candidates another transaction held, so this batch left their words where they were. */
  readonly held: number;
}

/** One batch of the person's messages in one workspace that still hold words or files. */
const eraseBatch = async (
  transaction: ChatTx,
  now: Date,
  workspaceId: string,
  userId: string,
): Promise<Batch> => {
  // Chat's own set makes the link, and a database migrated without it has no message to carry a file.
  const linked = await tableExists(transaction, 'message_attachments');
  const candidates = await transaction
    .selectFrom('messages')
    .select(['id', 'channel_id'])
    .where('workspace_id', '=', workspaceId)
    .where('sender_id', '=', userId)
    .where((eb) =>
      eb.or([
        eb('deleted_at', 'is', null),
        ...(linked
          ? [
              eb.exists(
                eb
                  .selectFrom('message_attachments')
                  .select('message_attachments.attachment_id')
                  .whereRef('message_attachments.message_id', '=', 'messages.id'),
              ),
            ]
          : []),
      ]),
    )
    .orderBy('id')
    .limit(ERASURE_BATCH)
    .execute();
  if (candidates.length === 0) return { emptied: 0, files: 0, keys: [], last: true, held: 0 };
  await lockMemberships(transaction, channelsOf(candidates));
  const rows = await transaction
    .selectFrom('messages')
    .select(REMOVED_COLUMNS)
    .where(
      'id',
      'in',
      candidates.map((row) => row.id),
    )
    .orderBy('id')
    .forUpdate()
    .skipLocked()
    .execute();
  if (rows.length === 0) {
    return { emptied: 0, files: 0, keys: [], last: true, held: candidates.length };
  }
  await takeBackLive(transaction, now, rows);
  const emptied = await tombstoneRows(
    transaction,
    now,
    rows.filter((row) => row.deleted_at === null).map((row) => row.id),
  );
  const files = await dropMessageFiles(
    transaction,
    workspaceId,
    rows.map((row) => row.id),
  );
  return {
    emptied: emptied.length,
    files: files.count,
    keys: files.keys,
    last: candidates.length < ERASURE_BATCH,
    held: candidates.length - rows.length,
  };
};

export interface ContentErased {
  readonly workspaceId: string;
  readonly messages: number;
  readonly files: number;
  readonly leftBehind: number;
  /**
   * Messages still holding words because another transaction had them when the last batch ran — at
   * least that many, as a batch that finds all of its candidates held cannot see past them. A run
   * again takes them; unlike the retention purge's, this is not left for the next night.
   */
  readonly lockedMessages: number;
}

/**
 * Every message the person wrote in each of these workspaces, emptied; their files gone. One line on
 * each workspace's trail, with what went. Run again, it finds nothing and says so.
 */
export const eraseContent = async (
  dependencies: JobDependencies & { readonly storage: ObjectStore },
  userId: string,
  workspaceIds: readonly string[],
): Promise<readonly ContentErased[]> => {
  const { database, clock, storage, log } = dependencies;
  const done: ContentErased[] = [];
  for (const workspaceId of [...workspaceIds].sort()) {
    const now = clock.now();
    // A note can be written on somebody else's root; erase that person's words without deleting the root.
    for (;;) {
      const cleared = await database
        .updateTable('messages')
        .set({
          decision_note: '',
          decision_url: null,
          decision_updated_by: null,
          knowledge_version: sql<number>`knowledge_version + 1`,
          state_version: sql<number>`state_version + 1`,
        })
        .where('workspace_id', '=', workspaceId)
        .where('decision_updated_by', '=', userId)
        .where(
          'id',
          'in',
          database
            .selectFrom('messages')
            .select('id')
            .where('workspace_id', '=', workspaceId)
            .where('decision_updated_by', '=', userId)
            .orderBy('id')
            .limit(ERASURE_BATCH),
        )
        .executeTakeFirst();
      if (cleared.numUpdatedRows < BigInt(ERASURE_BATCH)) break;
    }
    let messages = 0;
    let files = 0;
    let leftBehind = 0;
    let lockedMessages = 0;
    for (;;) {
      const batch = await atomicallyOn(database)(
        async (transaction) => await eraseBatch(transaction, now, workspaceId, userId),
      );
      messages += batch.emptied;
      files += batch.files;
      // The rows are gone for good: only now may their objects go; one refused waits (D-141).
      leftBehind += await drainObjectDeletions(
        { atomically: atomicallyOn(database), storage, log },
        batch.keys,
      );
      if (batch.last) {
        // A row held in an earlier batch comes up again as a candidate, so only the closing batch is the count.
        lockedMessages = batch.held;
        break;
      }
    }
    await atomicallyOn(database)(async (transaction) => {
      await recordAudit(transaction, clock, {
        workspaceId,
        actorUserId: null,
        action: 'content.erased',
        targetType: 'user',
        targetId: userId,
        metadata: {
          messages: String(messages),
          files: String(files),
          ...(leftBehind === 0 ? {} : { filesLeft: String(leftBehind) }),
          ...(lockedMessages === 0 ? {} : { messagesLocked: String(lockedMessages) }),
        },
      });
    });
    done.push({ workspaceId, messages, files, leftBehind, lockedMessages });
  }
  return done;
};

/** What an operator asked for, read from the command line; or why it cannot be done. */
export type ErasurePlan =
  | { readonly ok: true; readonly userId: string; readonly workspaceIds: readonly string[] }
  | { readonly ok: false; readonly reason: string };

const USAGE =
  'usage: bun run erase:content <username | email | user id> (--workspace <slug> | --all)';

/**
 * The person and the workspaces, from `<who> --workspace <slug>` or `<who> --all`. The person is found
 * by id, by username or by address, exactly — an erased person by id or by their `deleted-user-…`
 * name. `--all` is every workspace where they wrote anything, a decision note included: the self-hoster's,
 * who controls them all.
 */
export const planContentErasure = async (
  executor: ChatDb,
  argv: readonly string[],
): Promise<ErasurePlan> => {
  const [who, flag, slug, ...rest] = argv;
  if (who === undefined || rest.length > 0) return { ok: false, reason: USAGE };
  if (!(flag === '--all' ? slug === undefined : flag === '--workspace' && slug !== undefined)) {
    return { ok: false, reason: USAGE };
  }
  const person = await executor
    .selectFrom('users')
    .select('id')
    .where((eb) =>
      eb.or([
        ...(UUID.test(who) ? [eb('id', '=', who)] : []),
        eb('username', '=', who),
        eb('email', '=', who.toLowerCase()),
      ]),
    )
    .executeTakeFirst();
  if (person === undefined) return { ok: false, reason: 'nobody is known by that' };
  if (flag === '--all') {
    // Their words are messages they sent and decision notes they left on other people's roots.
    const touched = await executor
      .selectFrom('messages')
      .select('workspace_id')
      .distinct()
      .where((eb) =>
        eb.or([eb('sender_id', '=', person.id), eb('decision_updated_by', '=', person.id)]),
      )
      .execute();
    return { ok: true, userId: person.id, workspaceIds: touched.map((row) => row.workspace_id) };
  }
  const workspace = await executor
    .selectFrom('workspaces')
    .select('id')
    .where('slug', '=', slug ?? '')
    .executeTakeFirst();
  if (workspace === undefined) return { ok: false, reason: 'no workspace has that address' };
  return { ok: true, userId: person.id, workspaceIds: [workspace.id] };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
