/**
 * What the server's administrator may see of the outbox (D-288 §12): the dead facts and the ones stuck behind their backoff, as
 * metadata, and one row whole. The list never carries a payload; the one-row read does, because a fact cannot be judged
 * (fixed and requeued, or discarded) without it, and the caller writes that read on the server's trail. This file and
 * `outbox-drain.ts` are the only readers of the table, so the route that asks stays out of it (`core-tables.test.ts`).
 */
import type { Executor } from '@purlay/db';
import type {
  ServerOutboxFact,
  ServerOutboxFactDetail,
  ServerOutboxPage,
  ServerOutboxQuery,
} from '@purlay/types';
import { OUTBOX_STALE_AFTER_SECONDS } from './outbox-report';

const LIST_DEFAULT = 50;

const COLUMNS = [
  'id',
  'fact_id',
  'type',
  'shape',
  'workspace_id',
  'producer',
  'consumer',
  'state',
  'attempts',
  'last_error',
  'created_at',
  'next_attempt_at',
  'finished_at',
] as const;

interface Metadata {
  readonly id: string;
  readonly fact_id: string;
  readonly type: string;
  readonly shape: number;
  readonly workspace_id: string;
  readonly producer: string;
  readonly consumer: string;
  readonly state: string;
  readonly attempts: number;
  readonly last_error: string | null;
  readonly created_at: Date;
  readonly next_attempt_at: Date;
  readonly finished_at: Date | null;
}

const factOf = (row: Metadata): ServerOutboxFact => ({
  id: row.id,
  factId: row.fact_id,
  type: row.type,
  shape: row.shape,
  workspaceId: row.workspace_id,
  producer: row.producer,
  consumer: row.consumer,
  state: row.state,
  attempts: row.attempts,
  lastError: row.last_error,
  createdAt: row.created_at.toISOString(),
  nextAttemptAt: row.next_attempt_at.toISOString(),
  finishedAt: row.finished_at?.toISOString() ?? null,
});

/** The facts asked for, oldest first by id (a UUIDv7), a page at a time. `dead` is the default: what needs a person. */
export const listOutboxFacts = async (
  database: Executor,
  query: ServerOutboxQuery,
  now: Date,
): Promise<ServerOutboxPage> => {
  const limit = query.limit ?? LIST_DEFAULT;
  const state = query.state ?? 'dead';
  let statement = database
    .selectFrom('outbox')
    .select(COLUMNS)
    .orderBy('id')
    .limit(limit + 1);
  statement =
    state === 'stuck'
      ? statement
          .where('state', '=', 'pending')
          .where('created_at', '<', new Date(now.getTime() - OUTBOX_STALE_AFTER_SECONDS * 1000))
      : statement.where('state', '=', state);
  if (query.after !== undefined) statement = statement.where('id', '>', query.after);
  if (query.consumer !== undefined) statement = statement.where('consumer', '=', query.consumer);
  if (query.type !== undefined) statement = statement.where('type', '=', query.type);
  if (query.workspaceId !== undefined)
    statement = statement.where('workspace_id', '=', query.workspaceId);
  const rows = await statement.execute();
  const data = rows.slice(0, limit).map(factOf);
  return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
};

/** One delivery whole, payload included; `undefined` where there is none. The caller records that it was read. */
export const readOutboxFact = async (
  database: Executor,
  id: string,
): Promise<ServerOutboxFactDetail | undefined> => {
  const row = await database
    .selectFrom('outbox')
    .select([...COLUMNS, 'payload', 'correlation_id', 'caused_by'])
    .where('id', '=', id)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    ...factOf(row),
    payload: row.payload,
    correlationId: row.correlation_id,
    causedBy: row.caused_by,
  };
};
