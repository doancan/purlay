/**
 * The core's notification sink (D-286): the one place a module's notice becomes a row of `inbox_entries`, written in the
 * caller's transaction (`platform/ports/notification-sink.ts`).
 *
 * What it refuses and what it passes over:
 * - **A kind the calling module does not declare** is a mistake of the module and throws, so the caller's transaction rolls
 *   back and the mistake is seen, not swallowed: a kind no running module declares, and one another module declares, alike.
 *   A sink is made for one module (`module`, bound where the module's routes are made, never a word the caller passes), and
 *   the row is written as that module: a module cannot write a notice as another, or list one under another's name.
 * - **A person who is not a current member** of the workspace, or is the one acting, is told nothing: nobody is owed a notice
 *   of what they did themselves or of a workspace they have left. The membership is read under a share lock, so a member
 *   removed at that moment is not told.
 * - **A kind declared `pushed`** is also pushed to the person's devices once the notice has committed (`announce`), by the push
 *   sender, which holds it for Deep Work and quiet hours (`modules/push/sender.ts`, D-286 §9).
 * - **Too many unread**: a person has at most `UNREAD_PER_MODULE_MAX` unread notices of one module in one workspace. The notice
 *   that would make one more reads the oldest unread as history in the same statement chain (never deleted: the sweep keeps it
 *   as it keeps any read one), and the count is `collapsed` on what is answered and in `purlay_inbox_collapsed_total`. Refusing
 *   the new notice would hide the thing happening now; a loop of notices can no longer grow a person's list or badge. It is a
 *   bound and not a lock: two writes at once may leave a notice or two above it until the next one.
 * - **Another notice of the same subject**, while the first is unread, is raised to the top and takes the newer words, not added
 *   (`uq_inbox_unread_subject`): a retried request leaves one row.
 * - **Many notices at once** (`notifyMany`, a notice for a whole workspace) are judged as one: the membership of every recipient is
 *   read in one statement, the notices are written in one `INSERT`, and the cap is kept for every recipient in one `UPDATE`, so
 *   the statements a fan-out costs do not grow with the people it reaches. One notice is a batch of one.
 */
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { sql, type Transaction } from '@purlay/db';
import { messageId, Uuid } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { inboxUpdatedPublications, publishAfterCommit, type EventBus } from '../../platform/events';
import type { Logger } from '../../platform/logging';
import type { Counter } from '../../platform/metrics';
import type {
  ModuleNotice,
  NotificationSink,
  WrittenNotice,
} from '../../platform/ports/notification-sink';
import type { WorkspaceScope } from '../../platform/ports/record-ref';
import { assertMinted, type WorkspaceContext } from '../../platform/tenancy';
import { assertTurn } from '../../platform/workspace-turn';
import type { PushSender } from '../push/sender';
import { enqueuePush } from '../../platform/push-work';

/** What the table's CHECK holds as well, so a mistake is named here and not as a database error. */
const PARAMS_MAX_BYTES = 1024;
const PARAMS_MAX_ENTRIES = 8;
const SUBJECT_TYPE_MAX = 32;

/**
 * Unread notices of one module a person may have in one workspace (red-team F8): a page of the list is 50, so this is four
 * pages nobody reads through. A module's sender is bounded by the write budget and its own limits, not by this: the person who
 * is told is the one it protects.
 */
export const UNREAD_PER_MODULE_MAX = 200;

/** A key is a name of at most 24 characters, checked apart: TypeBox reads no pattern or length off a record's key. */
const PARAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,23}$/;
const Params = Type.Record(
  Type.String(),
  Type.Union([Type.String({ maxLength: 200 }), Type.Number(), Type.Boolean(), Type.Null()]),
  { maxProperties: PARAMS_MAX_ENTRIES },
);

/** Who declares each kind of notice a process may write: the kind, and the module whose manifest names it. */
export type KindOwners = ReadonlyMap<string, string>;

/** What is wrong with a notice a module sent, or `undefined` when it is well formed. */
const problemWith = (notice: ModuleNotice): string | undefined => {
  if (!Value.Check(Uuid, notice.recipientId)) return 'the recipient is not an id';
  if (!Value.Check(Uuid, notice.subject.id)) return 'the subject is not an id';
  if (notice.subject.type.length === 0 || notice.subject.type.length > SUBJECT_TYPE_MAX) {
    return `the subject's type is not 1 to ${String(SUBJECT_TYPE_MAX)} characters`;
  }
  if (
    !Value.Check(Params, notice.params) ||
    !Object.keys(notice.params).every((key) => PARAM_KEY.test(key))
  ) {
    return 'the params are not short plain values under names';
  }
  if (new TextEncoder().encode(JSON.stringify(notice.params)).length > PARAMS_MAX_BYTES) {
    return `the params are over ${String(PARAMS_MAX_BYTES)} bytes`;
  }
  return undefined;
};

/**
 * Reads, as of `now`, every unread notice of each person's module beyond their newest `UNREAD_PER_MODULE_MAX`, for all of them in
 * one statement, and answers how many it read for each person. The newest are by `id`, the order the list shows (a raised notice
 * has a new id), and the notices just written are among them. Uses the unread index (`uq_inbox_unread_subject`'s prefix), so it
 * looks at the unread rows and no read one.
 */
const collapseOldestUnread = async (
  transaction: Transaction,
  {
    workspaceId,
    userIds,
    module,
    now,
  }: { workspaceId: string; userIds: readonly string[]; module: string; now: Date },
): Promise<ReadonlyMap<string, number>> => {
  const ranked = transaction
    .selectFrom('inbox_entries')
    .select([
      'id',
      sql<number>`row_number() over (partition by user_id order by id desc)`.as('newest'),
    ])
    .where('user_id', 'in', userIds)
    .where('workspace_id', '=', workspaceId)
    .where('module', '=', module)
    .where('read_at', 'is', null);
  const collapsed = await transaction
    .updateTable('inbox_entries')
    .set({ read_at: now })
    .where('id', 'in', (eb) =>
      eb
        .selectFrom(ranked.as('ranked'))
        .select('ranked.id')
        .where('ranked.newest', '>', UNREAD_PER_MODULE_MAX),
    )
    .returning('user_id')
    .execute();
  const counts = new Map<string, number>();
  for (const { user_id: userId } of collapsed) counts.set(userId, (counts.get(userId) ?? 0) + 1);
  return counts;
};

/** Who writes a batch: a person in a workspace (`notify`) or a turn no person is taking (`notifyIn`). */
interface Caller {
  /** Read after the notices have been judged, so a call with nothing to write for names no workspace. */
  readonly whoFor: () => { readonly workspaceId: string; readonly actorId: string | null };
  /** Asked once the notices are known well formed and the module not stopped: throws for a workspace that was forged, false for one that may not be told. */
  readonly authorized: () => boolean;
}

/** One row per person and subject: a second notice of one subject to one person in a batch is the later one, as it would be one after the other. */
const lastOfEachSubject = (notices: readonly ModuleNotice[]): ModuleNotice[] => [
  ...new Map(
    notices.map((notice) => [
      JSON.stringify([notice.recipientId, notice.kind, notice.subject.id]),
      notice,
    ]),
  ).values(),
];

export const notificationSink = (dependencies: {
  /** The module this sink is handed to: the one every notice it writes is written as, and the one that must declare its kind. */
  readonly module: string;
  readonly clock: Clock;
  readonly kinds: KindOwners;
  readonly bus: EventBus;
  readonly log: Logger;
  /** Notices written, by module and kind: counted once they have committed, so a rolled-back one is never counted. */
  readonly written: Counter<'module' | 'kind'>;
  /** Older unread notices read as history to stay within `UNREAD_PER_MODULE_MAX`, by module and kind: counted once they have committed. */
  readonly collapsed: Counter<'module' | 'kind'>;
  /** The kinds the manifests declare `pushed`: the others are only listed. */
  readonly pushedKinds: ReadonlySet<string>;
  /** Captures and tells the devices of a pushed kind. */
  readonly push?: Pick<PushSender, 'capture' | 'toldInbox'>;
  /** Whether the administrator has stopped the module at run time (D-296): its notices are not written. Absent, never. */
  readonly suspended?: () => boolean;
}): NotificationSink => {
  /** Refuses a notice the calling module may not send or that is not well formed: a mistake of the module, thrown. */
  const check = (notice: ModuleNotice): void => {
    const { module } = dependencies;
    const declaredBy = dependencies.kinds.get(notice.kind);
    if (declaredBy === undefined) {
      throw new Error(`no running module declares the notification kind "${notice.kind}"`);
    }
    if (declaredBy !== module) {
      throw new Error(
        `the module "${module}" cannot write the notification kind "${notice.kind}": it is declared by "${declaredBy}"`,
      );
    }
    const problem = problemWith(notice);
    if (problem !== undefined) throw new Error(`a notice of kind "${notice.kind}": ${problem}`);
  };

  const write = async (
    transaction: Transaction,
    whoFor: Caller['whoFor'],
    notices: readonly ModuleNotice[],
    authorized: Caller['authorized'],
  ): Promise<WrittenNotice[]> => {
    const { module } = dependencies;
    for (const notice of notices) check(notice);
    // A stopped module tells nobody anything, and what it would have said is not kept for later (D-296).
    if (dependencies.suspended?.() === true) return [];
    if (!authorized()) return [];
    const who = whoFor();
    const owed = lastOfEachSubject(notices).filter((notice) => notice.recipientId !== who.actorId);
    if (owed.length === 0) return [];
    // Erasure locks the workspace before its user; take the insert's foreign-key lock in that order.
    const workspace = await transaction
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', who.workspaceId)
      .where('deleted_at', 'is', null)
      .forKeyShare()
      .executeTakeFirst();
    if (workspace === undefined) return [];
    // In one order, so two fan-outs to overlapping people take their locks the same way round.
    const members = await transaction
      .selectFrom('workspace_members')
      .innerJoin('users', 'users.id', 'workspace_members.user_id')
      .select('workspace_members.user_id')
      .where('workspace_members.workspace_id', '=', who.workspaceId)
      .where('workspace_members.user_id', 'in', [
        ...new Set(owed.map((notice) => notice.recipientId)),
      ])
      .where('users.deleted_at', 'is', null)
      .orderBy('workspace_members.user_id')
      .forKeyShare()
      .execute();
    const current = new Set(members.map((member) => member.user_id));
    const told = owed.filter((notice) => current.has(notice.recipientId));
    if (told.length === 0) return [];
    const now = dependencies.clock.now();
    const written = await transaction
      .insertInto('inbox_entries')
      .values(
        told.map((notice) => ({
          id: messageId(now),
          workspace_id: who.workspaceId,
          user_id: notice.recipientId,
          module,
          kind: notice.kind,
          actor_id: who.actorId,
          subject_type: notice.subject.type,
          subject_id: notice.subject.id,
          params: JSON.stringify(notice.params),
          created_at: now,
        })),
      )
      .onConflict((conflict) =>
        conflict
          .columns(['user_id', 'workspace_id', 'module', 'kind', 'subject_id'])
          .where('read_at', 'is', null)
          // A new id puts the row first in a list ordered by id, which is what raising it means.
          .doUpdateSet((builder) => ({
            id: builder.ref('excluded.id'),
            actor_id: builder.ref('excluded.actor_id'),
            params: builder.ref('excluded.params'),
            created_at: builder.ref('excluded.created_at'),
          })),
      )
      .returning(['id', 'user_id', 'kind', 'subject_id'])
      .execute();
    const collapsed = await collapseOldestUnread(transaction, {
      workspaceId: who.workspaceId,
      userIds: [...new Set(written.map((row) => row.user_id))],
      module,
      now,
    });
    const answers = written.map((row): WrittenNotice => ({
      entryId: row.id,
      workspaceId: who.workspaceId,
      recipientId: row.user_id,
      module,
      kind: row.kind,
      collapsed: 0,
    }));
    // A person's collapse is counted once, on the first of their notices, so a sum over the answers is the rows read.
    const counted = new Set<string>();
    const withCollapsed = answers.map((answer) => {
      if (counted.has(answer.recipientId)) return answer;
      counted.add(answer.recipientId);
      return { ...answer, collapsed: collapsed.get(answer.recipientId) ?? 0 };
    });
    await (dependencies.push?.capture ?? enqueuePush)(
      transaction,
      now,
      withCollapsed
        .filter((answer) => dependencies.pushedKinds.has(answer.kind))
        .map((answer) => ({
          source: 'inbox' as const,
          sourceId: answer.entryId,
          recordId: answer.entryId,
          workspaceId: who.workspaceId,
          userId: answer.recipientId,
          module,
          kind: answer.kind,
          createdAt: now,
        })),
    );
    return withCollapsed;
  };
  const contextOf = (context: WorkspaceContext): Caller => ({
    whoFor: () => ({ workspaceId: context.workspaceId, actorId: context.userId }),
    authorized: (): boolean => {
      assertMinted(context);
      return true;
    },
  });
  const turnOf = (turn: WorkspaceScope): Caller => ({
    whoFor: () => ({ workspaceId: turn.workspaceId, actorId: null }),
    authorized: (): boolean => {
      assertTurn(turn);
      // A workspace that lost the module hears nothing from its loops, as it hears nothing from its routes (D-289).
      return turn.modules === null || turn.modules.has(dependencies.module);
    },
  });
  return {
    notify: async (transaction, context, notice): Promise<WrittenNotice | undefined> => {
      const { whoFor, authorized } = contextOf(context);
      const [written] = await write(transaction, whoFor, [notice], authorized);
      return written;
    },
    notifyMany: async (transaction, context, notices): Promise<readonly WrittenNotice[]> => {
      const { whoFor, authorized } = contextOf(context);
      return await write(transaction, whoFor, notices, authorized);
    },
    notifyIn: async (transaction, turn, notice): Promise<WrittenNotice | undefined> => {
      const { whoFor, authorized } = turnOf(turn);
      const [written] = await write(transaction, whoFor, [notice], authorized);
      return written;
    },
    notifyManyIn: async (transaction, turn, notices): Promise<readonly WrittenNotice[]> => {
      const { whoFor, authorized } = turnOf(turn);
      return await write(transaction, whoFor, notices, authorized);
    },
    announce: async (written): Promise<void> => {
      for (const { module, kind, collapsed } of written) {
        dependencies.written.inc({ module, kind });
        dependencies.collapsed.inc({ module, kind }, collapsed);
      }
      dependencies.push?.toldInbox(
        written.filter((notice) => dependencies.pushedKinds.has(notice.kind)),
      );
      // One frame to each person for each workspace they were told in, however many notices they were written.
      const people = new Map<string, WrittenNotice>();
      for (const notice of written)
        people.set(`${notice.workspaceId}:${notice.recipientId}`, notice);
      await publishAfterCommit(dependencies.log, [
        [...people.values()].flatMap(({ workspaceId, recipientId }) =>
          inboxUpdatedPublications(dependencies.bus, dependencies.clock, workspaceId, [
            recipientId,
          ]),
        ),
      ]);
    },
  };
};
