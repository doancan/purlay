/**
 * A workspace's issues (D-254): the second module, kept as small as it can be. Every query is scoped to the
 * caller's `WorkspaceContext`, so an issue of another workspace is as absent as one that never was (D-21).
 *
 * - **Any member** makes an issue and changes any of them: title, body, status, assignee. The last write wins; there
 *   is no version to conflict on, because nothing here is long enough to lose.
 * - **The assignee is a current member** of the workspace, checked under the membership row's share lock so a member
 *   removed at that moment is not assigned. One who leaves later stays on the issue, as a name the client can no
 *   longer find.
 * - **Only its creator, or an owner or admin, deletes it.** Deleting is for real: nothing hangs off an issue.
 */
import type { Executor, Transaction } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import {
  messageId as newId,
  type CreateIssueRequest,
  type Issue,
  type IssuePage,
  type IssueQuery,
  type UpdateIssueRequest,
  Uuid,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { limitOf } from '../../platform/pagination';
import type { WorkspaceContext } from '../../platform/tenancy';

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

/** A title is one line as a list shows it: its edges are trimmed, and nothing but space is nothing. */
const titleOf = (title: string): string => {
  const trimmed = title.trim();
  if (trimmed === '') throw invalid('title', 'Give the issue a title.');
  return trimmed;
};

const requireAssignable = async (
  transaction: Transaction,
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

export const createIssue = async (
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  input: CreateIssueRequest,
): Promise<Issue> => {
  const title = titleOf(input.title);
  const assigneeId = input.assigneeId ?? null;
  if (assigneeId !== null) await requireAssignable(transaction, context, assigneeId);
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
  return toIssue(row);
};

/** The workspace's issues, newest first, from the one before `query.before`, of one status if asked. */
export const issuePage = async (
  executor: Executor,
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
  transaction: Transaction,
  clock: Clock,
  context: WorkspaceContext,
  issueId: string,
  input: UpdateIssueRequest,
): Promise<Issue> => {
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
  const row = await transaction
    .updateTable('issues')
    .set({ ...changes, updated_at: clock.now() })
    .where('id', '=', issueId)
    .where('workspace_id', '=', context.workspaceId)
    .returning(ISSUE_COLUMNS)
    .executeTakeFirst();
  if (row === undefined) throw issueNotFound();
  return toIssue(row);
};

/** Whether the caller may delete an issue: the one who made it, or the workspace's owners and admins. */
const mayDelete = (context: WorkspaceContext, createdBy: string | null): boolean =>
  context.role === 'owner' || context.role === 'admin' || createdBy === context.userId;

export const deleteIssue = async (
  transaction: Transaction,
  context: WorkspaceContext,
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
  if (!mayDelete(context, issue.created_by)) {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only the one who made an issue, or an owner or an admin, can delete it.',
    });
  }
  await transaction.deleteFrom('issues').where('id', '=', issueId).execute();
};
