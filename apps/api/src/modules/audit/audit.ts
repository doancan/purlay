/**
 * The audit trail (D-26, `SCHEMA.md` §9.1): one row per administrative action, written by the
 * service that does it, **in its transaction** — so an action that is refused or rolled back leaves
 * no record of having happened, and one that committed cannot be missing its record.
 *
 * What it says is who did what to whom, and for a change, from what to what. Never anything a
 * person wrote (`ARCHITECTURE.md` §10): an audit trail that copies messages is a second copy of the
 * most sensitive data in the product. Append-only (I-9): nothing updates or deletes a row of it,
 * which `append-only.test.ts` holds.
 */
import type { Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import type { Clock } from '../../platform/clock';

/** The verbs recorded so far; each is a stable machine-readable name, never built from input. */
type AuditAction = 'member.role_changed' | 'member.removed' | 'member.joined' | 'channel.created';

export interface AuditEntry {
  readonly workspaceId: string;
  /** Who did it; null only when nobody did (a job). */
  readonly actorUserId: string | null;
  readonly action: AuditAction;
  readonly targetType: 'user' | 'channel';
  readonly targetId: string;
  /** What changed, by name: never content, never a token, never an email address. */
  readonly metadata?: Readonly<Record<string, string>>;
}

export const recordAudit = async (
  executor: Executor,
  clock: Clock,
  entry: AuditEntry,
): Promise<void> => {
  const now = clock.now();
  await executor
    .insertInto('audit_log')
    .values({
      // Application-generated, as a message's: the trail is read newest first by keyset (D-8).
      id: messageId(now),
      workspace_id: entry.workspaceId,
      actor_user_id: entry.actorUserId,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      metadata: JSON.stringify(entry.metadata ?? {}),
      created_at: now,
    })
    .execute();
};
