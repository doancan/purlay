/**
 * The trail of changes to the server's own settings (D-26, D-179 §4.8, `SCHEMA.md` §9.1a): one row per
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
  | 'server.workspace_creators_changed'
  /** The break-glass command set the administrator's password; the actor is the account itself. */
  | 'server.admin_password_reset';

export const recordServerAudit = async (
  executor: Executor,
  clock: Clock,
  entry: { readonly actorUserId: string; readonly action: ServerAuditAction },
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
      created_at: now,
    })
    .execute();
  writeAuditLine({
    trail: 'server',
    entryId: id,
    action: entry.action,
    actorId: entry.actorUserId,
    workspaceId: null,
    targetType: null,
    targetId: null,
    at: now,
  });
};
