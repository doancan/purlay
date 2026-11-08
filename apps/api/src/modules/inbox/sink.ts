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
 * - **Another notice of the same subject**, while the first is unread, is raised to the top and takes the newer words, not added
 *   (`uq_inbox_unread_subject`): a retried request leaves one row.
 */
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
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
import type { PushSender } from '../push/sender';

/** What the table's CHECK holds as well, so a mistake is named here and not as a database error. */
const PARAMS_MAX_BYTES = 1024;
const PARAMS_MAX_ENTRIES = 8;
const SUBJECT_TYPE_MAX = 32;

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

export const notificationSink = (dependencies: {
  /** The module this sink is handed to: the one every notice it writes is written as, and the one that must declare its kind. */
  readonly module: string;
  readonly clock: Clock;
  readonly kinds: KindOwners;
  readonly bus: EventBus;
  readonly log: Logger;
  /** Notices written, by module and kind: counted once they have committed, so a rolled-back one is never counted. */
  readonly written: Counter<'module' | 'kind'>;
  /** The kinds the manifests declare `pushed`: the others are only listed. */
  readonly pushedKinds: ReadonlySet<string>;
  /** Tells the devices of a pushed kind; absent where web push is off. */
  readonly push?: Pick<PushSender, 'toldInbox'>;
}): NotificationSink => ({
  notify: async (transaction, context, notice): Promise<WrittenNotice | undefined> => {
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
    if (notice.recipientId === context.userId) return undefined;
    // Erasure locks the workspace before its user; take the insert's foreign-key lock in that order.
    const workspace = await transaction
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', context.workspaceId)
      .where('deleted_at', 'is', null)
      .forKeyShare()
      .executeTakeFirst();
    if (workspace === undefined) return undefined;
    const member = await transaction
      .selectFrom('workspace_members')
      .innerJoin('users', 'users.id', 'workspace_members.user_id')
      .select('workspace_members.user_id')
      .where('workspace_members.workspace_id', '=', context.workspaceId)
      .where('workspace_members.user_id', '=', notice.recipientId)
      .where('users.deleted_at', 'is', null)
      .forKeyShare()
      .executeTakeFirst();
    if (member === undefined) return undefined;
    const now = dependencies.clock.now();
    const written = await transaction
      .insertInto('inbox_entries')
      .values({
        id: messageId(now),
        workspace_id: context.workspaceId,
        user_id: notice.recipientId,
        module,
        kind: notice.kind,
        actor_id: context.userId,
        subject_type: notice.subject.type,
        subject_id: notice.subject.id,
        params: JSON.stringify(notice.params),
        created_at: now,
      })
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
      .returning('id')
      .executeTakeFirstOrThrow();
    return {
      entryId: written.id,
      workspaceId: context.workspaceId,
      recipientId: notice.recipientId,
      module,
      kind: notice.kind,
    };
  },
  announce: async (written): Promise<void> => {
    for (const { module, kind } of written) dependencies.written.inc({ module, kind });
    dependencies.push?.toldInbox(
      written.filter((notice) => dependencies.pushedKinds.has(notice.kind)),
    );
    // One frame to each person for each workspace they were told in, however many notices they were written.
    const people = new Map<string, WrittenNotice>();
    for (const notice of written) people.set(`${notice.workspaceId}:${notice.recipientId}`, notice);
    await publishAfterCommit(dependencies.log, [
      [...people.values()].flatMap(({ workspaceId, recipientId }) =>
        inboxUpdatedPublications(dependencies.bus, dependencies.clock, workspaceId, [recipientId]),
      ),
    ]);
  },
});
