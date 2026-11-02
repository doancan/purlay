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
import {
  PAGE_LIMIT,
  messageId,
  messageIdFloor,
  type AuditAction,
  type AuditEntry as AuditEntryShape,
  type AuditFilter,
  type AuditPage,
  type AuditQuery,
} from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { WorkspaceContext } from '../../platform/tenancy';
import type { Clock } from '../../platform/clock';
import { currentRequest } from '../../platform/logging';
import { writeAuditLine } from './lines';

export interface AuditEntry {
  readonly workspaceId: string;
  /** Who did it; null only when nobody did (a job). */
  readonly actorUserId: string | null;
  readonly action: AuditAction;
  readonly targetType: 'user' | 'channel' | 'integration' | 'invitation' | 'message' | 'workspace';
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
  // Application-generated, as a message's: the trail is read newest first by keyset (D-8), and a
  // window of time is a range of these (`trailPage`).
  const id = messageId(now);
  await executor
    .insertInto('audit_log')
    .values({
      id,
      workspace_id: entry.workspaceId,
      actor_user_id: entry.actorUserId,
      action: entry.action,
      target_type: entry.targetType,
      target_id: entry.targetId,
      metadata: JSON.stringify(entry.metadata ?? {}),
      // The session the request was made with; none for what no request did (D-116).
      session_id: currentRequest()?.sessionId ?? null,
      created_at: now,
    })
    .execute();
  writeAuditLine({
    trail: 'workspace',
    entryId: id,
    action: entry.action,
    actorId: entry.actorUserId,
    workspaceId: entry.workspaceId,
    targetType: entry.targetType,
    targetId: entry.targetId,
    at: now,
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
  });
};

/**
 * Who reads the trail, and so who downloads it (D-222): an owner or an admin, as managing members is
 * (§7.4). A member is refused for what they are, after their membership has made the workspace exist
 * for them.
 */
export const requireTrailReader = (context: WorkspaceContext): void => {
  if (context.role === 'member') {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner or an admin reads the trail.',
    });
  }
};

/** A field of the filter refused, by name (`API.md` §1). */
const refused = (field: string, says: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'The request did not match the contract.',
    details: { fields: { [field]: says } },
  });

/**
 * An instant the contract's pattern let through, read. The pattern takes `02-31` and `24:00`, which
 * `Date.parse` quietly rolls into the next month or day; a moment whose written clock is not the one it
 * reads back as is refused, never moved.
 */
const instant = (field: string, value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const at = Date.parse(value);
  const [y, mo, d, h, mi, s] = (/^(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/.exec(value) ?? [])
    .slice(1)
    .map(Number);
  const written =
    y === undefined ? Number.NaN : Date.UTC(y, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0);
  if (
    Number.isNaN(at) ||
    Number.isNaN(written) ||
    new Date(written).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    throw refused(field, 'is not a real moment');
  }
  return at;
};

/**
 * The filter, checked before anything is read: each instant a real one, and the window not empty or
 * backwards (`from` inclusive, `to` exclusive). Its own step so that a download is refused before it
 * is recorded, never after (D-222).
 */
export const checkedFilter = (filter: AuditFilter): AuditFilter => {
  const from = instant('from', filter.from);
  const to = instant('to', filter.to);
  if (from !== undefined && to !== undefined && from >= to) {
    throw refused('to', 'must be after from');
  }
  return filter;
};

/**
 * One page of the trail's rows in this workspace that the filter keeps, newest first by keyset on the
 * id (D-8), with who acted. **The window is a range of ids**: an entry's id is made from the instant it
 * is written, the instant that is its `created_at` (`recordAudit`), so `from` and `to` become the lowest
 * ids of their instants and the read stays on the workspace's index however long the trail is.
 */
export const trailPage = async (
  executor: Executor,
  context: WorkspaceContext,
  filter: AuditFilter,
  page: { readonly before?: string; readonly limit: number },
): Promise<AuditEntryShape[]> => {
  const from = instant('from', filter.from);
  const to = instant('to', filter.to);
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
    .limit(page.limit);
  if (filter.actorId !== undefined) {
    statement = statement.where('audit_log.actor_user_id', '=', filter.actorId);
  }
  if (filter.action !== undefined) {
    statement = statement.where('audit_log.action', '=', filter.action);
  }
  if (from !== undefined) statement = statement.where('audit_log.id', '>=', messageIdFloor(from));
  if (to !== undefined) statement = statement.where('audit_log.id', '<', messageIdFloor(to));
  if (page.before !== undefined) statement = statement.where('audit_log.id', '<', page.before);
  const rows = await statement.execute();
  return rows.map((row) => ({
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
  }));
};

/**
 * `GET /api/workspaces/:workspaceId/audit` (#70): the workspace's trail, newest first, a page at a
 * time by keyset on the id — narrowed by who, what and when on the server (D-222), never by a client
 * over the pages it happens to hold.
 */
export const auditTrail = async (
  executor: Executor,
  context: WorkspaceContext,
  query: AuditQuery,
): Promise<AuditPage> => {
  requireTrailReader(context);
  const { before, limit = PAGE_LIMIT.default, ...filter } = query;
  const rows = await trailPage(executor, context, checkedFilter(filter), {
    ...(before === undefined ? {} : { before }),
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  return {
    data: page,
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
