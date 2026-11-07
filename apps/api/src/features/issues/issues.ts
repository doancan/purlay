/**
 * A workspace's issues (D-254): the second module, kept as small as it can be. Every query is scoped to the
 * caller's `WorkspaceContext`, so an issue of another workspace is as absent as one that never was (D-21).
 *
 * - **Any member** makes an issue and changes any of them: title, body, status, assignee. The last write wins; there
 *   is no version to conflict on, because nothing here is long enough to lose.
 * - **The assignee is a current member** of the workspace, checked under the membership row's share lock so a member
 *   removed at that moment is not assigned. One who leaves later stays on the issue, as a name the client can no
 *   longer find.
 * - **An assignee is told** in the core's inbox, in the same transaction as the assignment (D-286): the notice is committed with
 *   the assignment or not at all, and the caller announces what was written once it has committed.
 * - **Only its creator, or an owner or admin, deletes it.** Deleting is for real: nothing hangs off an issue.
 */
import { Value } from '@sinclair/typebox/value';
import {
  ISSUES_PER_WORKSPACE_MAX,
  messageId as newId,
  type CreateIssueRequest,
  type Issue,
  type IssuePage,
  type IssueQuery,
  type UpdateIssueRequest,
  Uuid,
} from '@purlay/types';
import { recordAudit, type AuditEntry } from '../../modules/audit/audit';
import type { Clock } from '../../platform/clock';
import type { NotificationSink, WrittenNotice } from '../../platform/ports/notification-sink';
import { AppError } from '../../platform/errors';
import type { PermissionTable } from '../../platform/module-kit/permissions';
import { limitOf } from '../../platform/pagination';
import type { WorkspaceContext } from '../../platform/tenancy';
import type { IssuesDb, IssuesTx } from './schema';

const issueNotFound = (): AppError =>
  new AppError({ code: 'ISSUE_NOT_FOUND', message: 'Issue not found.' });

/** An id that is no UUID is no issue, and is not sent to the database to be refused there as a 500. */
const requireIssueId = (issueId: string): void => {
  if (!Value.Check(Uuid, issueId)) throw issueNotFound();
};

const invalid = (field: string, says: string): AppError =>
  new AppError({
    code: 'VALIDATION_FAILED',
    message: 'The request did not match the contract.',
    details: { fields: { [field]: says } },
  });

const ISSUE_COLUMNS = [
  'id',
  'title',
  'body',
  'status',
  'assignee_id',
  'created_by',
  'created_at',
  'updated_at',
] as const;

interface IssueRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: Issue['status'];
  readonly assignee_id: string | null;
  readonly created_by: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const toIssue = (row: IssueRow): Issue => ({
  id: row.id,
  title: row.title,
  body: row.body,
  status: row.status,
  assigneeId: row.assignee_id,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

/** What a write did, for the caller to announce after the commit: the issue, and the notices written with it. */
export interface IssueWrite {
  readonly issue: Issue;
  readonly told: readonly WrittenNotice[];
}

/** The kind of notice an assignment writes: a `type` of the manifest's `notifications` (`ISSUES_NOTIFICATION_KINDS`). */
const ASSIGNED = 'issue_assigned';

/** Tells the new assignee, in the caller's transaction; nobody when there is none, and nobody twice for one write. */
const tellAssignee = async (
  transaction: IssuesTx,
  inbox: NotificationSink,
  context: WorkspaceContext,
  issue: IssueRow,
): Promise<readonly WrittenNotice[]> => {
  if (issue.assignee_id === null) return [];
  const written = await inbox.notify(transaction, context, {
    kind: ASSIGNED,
    recipientId: issue.assignee_id,
    subject: { type: 'issue', id: issue.id },
    params: { title: issue.title },
  });
  return written === undefined ? [] : [written];
};

/** A title's edges are trimmed; the contract has already refused one with nothing visible in it (the `name` format). */
const titleOf = (title: string): string => title.trim();

const requireAssignable = async (
  transaction: IssuesTx,
  context: WorkspaceContext,
  assigneeId: string,
): Promise<void> => {
  const member = await transaction
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select('workspace_members.user_id')
    .where('workspace_members.workspace_id', '=', context.workspaceId)
    .where('workspace_members.user_id', '=', assigneeId)
    .where('users.deleted_at', 'is', null)
    .forKeyShare()
    .executeTakeFirst();
  if (member === undefined)
    throw invalid('assigneeId', 'Choose a current member of this workspace.');
};

/** What the trail says of an issue: who, what, which one, and for a change from what to what — never its words. */
const audit = (
  context: WorkspaceContext,
  action: 'issue.created' | 'issue.status_changed' | 'issue.assigned' | 'issue.deleted',
  issueId: string,
  metadata: Readonly<Record<string, string>> = {},
): AuditEntry => ({
  workspaceId: context.workspaceId,
  actorUserId: context.userId,
  action,
  targetType: 'issue',
  targetId: issueId,
  metadata,
});

/**
 * Whether the workspace may hold one more, counted under the workspace's row locked so that two makes at the cap
 * cannot both be the last. A count and not bytes: see `ISSUES_PER_WORKSPACE_MAX`.
 */
const requireRoom = async (transaction: IssuesTx, context: WorkspaceContext): Promise<void> => {
  await transaction
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', context.workspaceId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  const held = await transaction
    .selectFrom('issues')
    .select((builder) => builder.fn.countAll<string>().as('count'))
    .where('workspace_id', '=', context.workspaceId)
    .executeTakeFirstOrThrow();
  if (Number(held.count) >= ISSUES_PER_WORKSPACE_MAX) {
    throw new AppError({
      code: 'ISSUES_LIMIT',
      message: `A workspace holds at most ${String(ISSUES_PER_WORKSPACE_MAX)} issues; delete some first.`,
    });
  }
};

export const createIssue = async (
  transaction: IssuesTx,
  clock: Clock,
  context: WorkspaceContext,
  input: CreateIssueRequest,
  inbox: NotificationSink,
): Promise<IssueWrite> => {
  const title = titleOf(input.title);
  const assigneeId = input.assigneeId ?? null;
  if (assigneeId !== null) await requireAssignable(transaction, context, assigneeId);
  await requireRoom(transaction, context);
  const now = clock.now();
  const row = await transaction
    .insertInto('issues')
    .values({
      id: newId(now),
      workspace_id: context.workspaceId,
      title,
      body: input.body ?? '',
      assignee_id: assigneeId,
      created_by: context.userId,
      created_at: now,
      updated_at: now,
    })
    .returning(ISSUE_COLUMNS)
    .executeTakeFirstOrThrow();
  await recordAudit(transaction, clock, audit(context, 'issue.created', row.id));
  return { issue: toIssue(row), told: await tellAssignee(transaction, inbox, context, row) };
};

/** The workspace's issues, newest first, from the one before `query.before`, of one status if asked. */
export const issuePage = async (
  executor: IssuesDb,
  context: WorkspaceContext,
  query: IssueQuery,
): Promise<IssuePage> => {
  const limit = limitOf(query);
  let statement = executor
    .selectFrom('issues')
    .select(ISSUE_COLUMNS)
    .where('workspace_id', '=', context.workspaceId)
    .orderBy('id', 'desc')
    .limit(limit + 1);
  if (query.status !== undefined) statement = statement.where('status', '=', query.status);
  if (query.before !== undefined) statement = statement.where('id', '<', query.before);
  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  return {
    data: page.map(toIssue),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
  };
};

export const updateIssue = async (
  transaction: IssuesTx,
  clock: Clock,
  context: WorkspaceContext,
  issueId: string,
  input: UpdateIssueRequest,
  inbox: NotificationSink,
): Promise<IssueWrite> => {
  requireIssueId(issueId);
  const changes = {
    ...(input.title === undefined ? {} : { title: titleOf(input.title) }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.assigneeId === undefined ? {} : { assignee_id: input.assigneeId }),
  };
  if (input.assigneeId !== undefined && input.assigneeId !== null) {
    await requireAssignable(transaction, context, input.assigneeId);
  }
  const before = await transaction
    .selectFrom('issues')
    .select(['status', 'assignee_id'])
    .where('id', '=', issueId)
    .where('workspace_id', '=', context.workspaceId)
    .forUpdate()
    .executeTakeFirst();
  if (before === undefined) throw issueNotFound();
  const row = await transaction
    .updateTable('issues')
    .set({ ...changes, updated_at: clock.now() })
    // By id alone: the row is this workspace's and locked above.
    .where('id', '=', issueId)
    .returning(ISSUE_COLUMNS)
    .executeTakeFirst();
  if (row === undefined) throw issueNotFound();
  if (row.status !== before.status) {
    await recordAudit(
      transaction,
      clock,
      audit(context, 'issue.status_changed', row.id, { from: before.status, to: row.status }),
    );
  }
  if (row.assignee_id !== before.assignee_id) {
    await recordAudit(
      transaction,
      clock,
      audit(context, 'issue.assigned', row.id, {
        from: before.assignee_id ?? '',
        to: row.assignee_id ?? '',
      }),
    );
  }
  // Told only when the assignee changed: a retitle or a status change tells nobody.
  const told =
    row.assignee_id === before.assignee_id
      ? []
      : await tellAssignee(transaction, inbox, context, row);
  return { issue: toIssue(row), told };
};

/** The permission to delete an issue somebody else made, as the manifest declares it (`module.ts`). */
export const ISSUES_DELETE_ANY = 'issues.delete-any';

/** Whether the caller may delete an issue: the one who made it, or whoever holds the permission to delete any. */
const mayDelete = (
  permissions: PermissionTable,
  context: WorkspaceContext,
  createdBy: string | null,
): boolean => permissions.holds(context.role, ISSUES_DELETE_ANY) || createdBy === context.userId;

export const deleteIssue = async (
  transaction: IssuesTx,
  clock: Clock,
  context: WorkspaceContext,
  permissions: PermissionTable,
  issueId: string,
): Promise<void> => {
  requireIssueId(issueId);
  const issue = await transaction
    .selectFrom('issues')
    .select('created_by')
    .where('id', '=', issueId)
    .where('workspace_id', '=', context.workspaceId)
    .forUpdate()
    .executeTakeFirst();
  if (issue === undefined) throw issueNotFound();
  if (!mayDelete(permissions, context, issue.created_by)) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only the one who made an issue, or an owner or an admin, can delete it.',
    });
  }
  await transaction.deleteFrom('issues').where('id', '=', issueId).execute();
  await recordAudit(transaction, clock, audit(context, 'issue.deleted', issueId));
};
