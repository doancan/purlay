/**
 * Reading the core's inbox (D-286): a person's own notices in one workspace, newest first, and marking them read.
 *
 * Only the notices of the modules this process runs are listed, counted or marked: a module that is off keeps its rows
 * and shows none of them, and what it wrote is not read away behind its back by a person who cannot see it.
 */
import { Value } from '@sinclair/typebox/value';
import type { Executor } from '@purlay/db';
import {
  InboxEntry,
  type InboxPage,
  type InboxQuery,
  type MarkInboxReadRequest,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { limitOf } from '../../platform/pagination';
import type { WorkspaceContext } from '../../platform/tenancy';

const EMPTY_PAGE: InboxPage = { data: [], nextCursor: null, unreadCount: 0 };

interface Row {
  readonly id: string;
  readonly module: string;
  readonly kind: string;
  readonly actor_id: string | null;
  readonly subject_type: string;
  readonly subject_id: string;
  readonly params: unknown;
  readonly read_at: Date | null;
  readonly created_at: Date;
}

/** What the column holds, as the contract names it: the sink writes nothing else, and a value that is not is no params. */
const paramsOf = (value: unknown): InboxEntry['params'] =>
  Value.Check(InboxEntry.properties.params, value) ? value : {};

const toEntry = (row: Row): InboxEntry => ({
  id: row.id,
  module: row.module,
  kind: row.kind,
  actorId: row.actor_id,
  subject: { type: row.subject_type, id: row.subject_id },
  params: paramsOf(row.params),
  readAt: row.read_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
});

export const inboxPage = async (
  executor: Executor,
  context: WorkspaceContext,
  running: readonly string[],
  query: InboxQuery,
): Promise<InboxPage> => {
  if (running.length === 0) return EMPTY_PAGE;
  const limit = limitOf(query);
  let statement = executor
    .selectFrom('inbox_entries')
    .select([
      'id',
      'module',
      'kind',
      'actor_id',
      'subject_type',
      'subject_id',
      'params',
      'read_at',
      'created_at',
    ])
    .where('user_id', '=', context.userId)
    .where('workspace_id', '=', context.workspaceId)
    .where('module', 'in', running)
    .orderBy('id', 'desc')
    .limit(limit + 1);
  if (query.unreadOnly === true) statement = statement.where('read_at', 'is', null);
  if (query.before !== undefined) statement = statement.where('id', '<', query.before);
  const rows = await statement.execute();
  const unread = await executor
    .selectFrom('inbox_entries')
    .select((builder) => builder.fn.countAll<string>().as('count'))
    .where('user_id', '=', context.userId)
    .where('workspace_id', '=', context.workspaceId)
    .where('module', 'in', running)
    .where('read_at', 'is', null)
    .executeTakeFirstOrThrow();
  const page = rows.slice(0, limit);
  return {
    data: page.map(toEntry),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    unreadCount: Number(unread.count),
  };
};

/**
 * Reads these notices of the caller's, or all of theirs in the workspace; answers how many it newly read. An id that is not
 * the caller's, in this workspace, of a module that runs, or is read already, is not read and not reported: nobody can ask
 * whether another person's notice exists, and a repeat changes nothing.
 */
export const markInboxRead = async (
  executor: Executor,
  clock: Clock,
  context: WorkspaceContext,
  running: readonly string[],
  request: MarkInboxReadRequest,
): Promise<number> => {
  if (running.length === 0) return 0;
  let statement = executor
    .updateTable('inbox_entries')
    .set({ read_at: clock.now() })
    .where('user_id', '=', context.userId)
    .where('workspace_id', '=', context.workspaceId)
    .where('module', 'in', running)
    .where('read_at', 'is', null);
  if ('ids' in request) statement = statement.where('id', 'in', request.ids);
  const done = await statement.executeTakeFirst();
  return Number(done.numUpdatedRows);
};
