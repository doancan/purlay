/**
 * How a module tells a person something through the core's inbox (`MODULES.md` §4, D-286): a port the core defines and the
 * core implements (`modules/inbox/`), so a module that notifies imports types and no other module.
 *
 * The call runs **inside the caller's own transaction**: the notice is committed with the thing it is about or not at all, so
 * an assignment cannot commit without its notice and a rolled-back one leaves no phantom.
 */
import type { Transaction } from '@purlay/db';
import type { WorkspaceContext } from '../tenancy';
import type { WorkspaceScope } from './record-ref';

/** What a notice carries about its subject: short facts, never a body or a person's words (at most 1 KiB as JSON). */
type NoticeParams = Readonly<Record<string, string | number | boolean | null>>;

export interface ModuleNotice {
  /** A `type` of the `notifications` of the calling module's own manifest: the sink it is handed is bound to that module. */
  readonly kind: string;
  readonly recipientId: string;
  /** What the notice is about, by the module's own word for it and its id. */
  readonly subject: { readonly type: string; readonly id: string };
  readonly params: NoticeParams;
}

/** A notice as it was written: what the commit's after-step needs to tell the person it exists (`announce`, D-286 §3). */
export interface WrittenNotice {
  readonly entryId: string;
  readonly workspaceId: string;
  readonly recipientId: string;
  readonly module: string;
  readonly kind: string;
  /** How many older unread notices of the person's, of this module, the write read as history to keep them within the cap (0 almost always). */
  readonly collapsed: number;
}

export interface NotificationSink {
  /**
   * Writes the notice in `transaction` for a person who is a current member of the workspace and is not the one acting; for
   * anyone else it writes nothing and answers `undefined`. A kind the calling module does not declare in its own
   * manifest, whether no module declares it or another does, is refused with an error: it is a mistake of the module, not of
   * the person. Telling the same person of the same subject again, while the first is
   * unread, raises that one rather than adding another. A person's unread notices of one module in one workspace are bounded
   * (`UNREAD_PER_MODULE_MAX`): past it the oldest are read as history and counted in `collapsed`, so a loop cannot flood a list.
   */
  readonly notify: (
    transaction: Transaction,
    context: WorkspaceContext,
    notice: ModuleNotice,
  ) => Promise<WrittenNotice | undefined>;
  /**
   * `notify` for work no person is doing: a worker's sweep or a fact's consumer, for the workspace of a `turn` the framework handed
   * it (`perWorkspaceWorker`, a delivery). The notice has no actor, so it is owed to the recipient even if they were the cause,
   * and a workspace that lost the module hears nothing. Every other rule of `notify` holds: the kind must be the calling module's
   * own, the recipient a current member, the transaction the caller's.
   */
  readonly notifyIn: (
    transaction: Transaction,
    turn: WorkspaceScope,
    notice: ModuleNotice,
  ) => Promise<WrittenNotice | undefined>;
  /**
   * Called once the caller's transaction has **committed**, with what `notify` answered: counts the notices and tells each
   * person's own tabs to read their inbox again (`INBOX_UPDATED`). A hint, not the notice: it never throws, and a publish
   * that fails is logged and is not the request's error, as any publish after a commit is (D-35).
   */
  readonly announce: (written: readonly WrittenNotice[]) => Promise<void>;
}
