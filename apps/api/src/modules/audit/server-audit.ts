/**
 * The trail of changes to the server's own settings, and of what happens to a whole workspace — its erasure
 * once its deletion's grace period is over (D-242) — (D-26, D-179 §4.8, `SCHEMA.md` §9.1a): one row per
 * change, written **in the transaction that saves the setting**, so a change that did not commit leaves
 * no record and one that did cannot lack it. Who, which setting and what was done — the action names
 * the first two of those — and never a value: a secret least of all. Append-only (I-9): nothing here
 * updates or deletes.
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import { currentRequest } from '../../platform/logging';
import { messageId } from '@purlay/types';
import { writeAuditLine } from './lines';

/** The changes recorded, each a stable machine-readable name. */
export type ServerAuditAction =
  | 'server.github_connected'
  | 'server.github_disconnected'
  | 'server.oidc_connected'
  | 'server.oidc_disconnected'
  | 'server.smtp_connected'
  | 'server.smtp_disconnected'
  | 'server.sign_up_changed'
  /** The sign-in policy (D-239): two-step verification required of a password, or not; passwords on or off. */
  | 'server.two_factor_requirement_changed'
  | 'server.password_sign_in_changed'
  /** How long a session lives (D-244): signed out after so long unused, and after so long at all. */
  | 'server.session_idle_timeout_changed'
  | 'server.session_max_age_changed'
  | 'server.workspace_creators_changed'
  /** The break-glass command set the administrator's password; the actor is the account itself. */
  | 'server.admin_password_reset'
  /** An account suspended, and lifted (D-233): whose, in `target_user_id`. */
  | 'server.account_suspended'
  | 'server.account_restored'
  /**
   * A person asked for an export of their own data, and downloaded it (D-241): the actor and the account
   * are the person. The operator answers access requests (D-28), so the record is on their trail.
   */
  | 'account.export_requested'
  | 'account.export_downloaded'
  /** A workspace's content erased, its deletion's grace period over (D-242): which, in `target_workspace_id`. */
  | 'server.workspace_purged';

export const recordServerAudit = async (
  executor: Executor,
  clock: Clock,
  entry: {
    /** Who did it; null only when nobody did (a job, D-242). */
    readonly actorUserId: string | null;
    readonly action: ServerAuditAction;
    /** Whose account the entry is about, for an action that has one (D-233). */
    readonly targetUserId?: string;
    /** Which workspace the entry is about, for an action that has one (D-242). */
    readonly targetWorkspaceId?: string;
  },
): Promise<void> => {
  const now = clock.now();
  const id = messageId(now);
  await executor
    .insertInto('server_audit_log')
    .values({
      id,
      actor_user_id: entry.actorUserId,
      action: entry.action,
      session_id: currentRequest()?.sessionId ?? null,
      target_user_id: entry.targetUserId ?? null,
      target_workspace_id: entry.targetWorkspaceId ?? null,
      created_at: now,
    })
    .execute();
  writeAuditLine({
    trail: 'server',
    entryId: id,
    action: entry.action,
    actorId: entry.actorUserId,
    workspaceId: entry.targetWorkspaceId ?? null,
    targetType:
      entry.targetUserId !== undefined
        ? 'user'
        : entry.targetWorkspaceId !== undefined
          ? 'workspace'
          : null,
    targetId: entry.targetUserId ?? entry.targetWorkspaceId ?? null,
    at: now,
  });
};
