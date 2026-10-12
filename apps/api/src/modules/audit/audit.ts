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
import { PAGE_LIMIT, messageId, type AuditPage, type AuditQuery } from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { WorkspaceContext } from '../../platform/tenancy';
import type { Clock } from '../../platform/clock';

/** The verbs recorded so far; each is a stable machine-readable name, never built from input. */
type AuditAction =
  | 'member.role_changed'
  | 'member.removed'
  | 'member.joined'
  | 'channel.created'
  | 'integration.token_set'
  | 'integration.token_removed';

export interface AuditEntry {
  readonly workspaceId: string;
  /** Who did it; null only when nobody did (a job). */
  readonly actorUserId: string | null;
  readonly action: AuditAction;
  readonly targetType: 'user' | 'channel' | 'integration';
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

/**
 * `GET /api/workspaces/:workspaceId/audit` (#70): the workspace's trail, newest first, a page at a
 * time by keyset on the id. An owner's and an admin's to read, as managing members is (§7.4); a
 * member is refused for what they are, after their membership has made the workspace exist for them.
 */
export const auditTrail = async (
  executor: Executor,
  context: WorkspaceContext,
  query: AuditQuery,
): Promise<AuditPage> => {
  if (context.role === 'member') {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner or an admin reads the trail.',
    });
  }
  const limit = query.limit ?? PAGE_LIMIT.default;
  let statement = executor
    .selectFrom('audit_log')
    .leftJoin('users', 'users.id', 'audit_log.actor_user_id')
    .select([
      'audit_log.id',
      'audit_log.action',
      'audit_log.target_type',
      'audit_log.target_id',
      'audit_log.metadata',
      'audit_log.created_at',
      'users.id as actor_id',
      'users.username',
      'users.display_name',
      'users.avatar_url',
    ])
    .where('audit_log.workspace_id', '=', context.workspaceId)
    .orderBy('audit_log.id', 'desc')
    .limit(limit + 1);
  if (query.before !== undefined) statement = statement.where('audit_log.id', '<', query.before);
  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  return {
    data: page.map((row) => ({
      id: row.id,
      actor:
        row.actor_id === null || row.username === null || row.display_name === null
          ? null
          : {
              id: row.actor_id,
              username: row.username,
              displayName: row.display_name,
              avatarUrl: row.avatar_url,
            },
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: asMetadata(row.metadata),
      createdAt: new Date(row.created_at).toISOString(),
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};

/** What was written as names and strings, read back as such; anything else is not shown. */
const asMetadata = (value: unknown): Record<string, string> =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {};
