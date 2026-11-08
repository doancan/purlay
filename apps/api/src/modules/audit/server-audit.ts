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
export type { ServerAuditAction } from '@purlay/types';
import type { ServerAuditAction } from '@purlay/types';

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
    /** Which module an entry about a grant is about, by id (D-289). */
    readonly targetModule?: string;
    /** The operator's own words for why, on the entry that carries them (`server.module_suspended`, D-296). */
    readonly note?: string;
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
      target_module: entry.targetModule ?? null,
      note: entry.note ?? null,
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
