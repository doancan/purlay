/**
 * What the server's administrator may see of the outbox (D-288 §12): the dead facts and the ones stuck behind their backoff, as
 * metadata, and one row whole. The list never carries a payload; the one-row read does, because a fact cannot be judged
 * (fixed and requeued, or discarded) without it, and the caller writes that read on the server's trail. This file and
 * `outbox-drain.ts` are the only readers of the table, so the route that asks stays out of it (`core-tables.test.ts`).
 */
import { sql, type Executor, type Transaction } from '@purlay/db';
import type {
  ServerOutboxFact,
  ServerOutboxFactDetail,
  ServerOutboxPage,
  ServerOutboxQuery,
} from '@purlay/types';
import { DAY_MS } from './clock';
import { readGrants } from './grants';
import { OUTBOX_STALE_AFTER_SECONDS, type OutboxView } from './outbox-report';

const LIST_DEFAULT = 50;

/** How many pages of rows a list of stuck facts reads past held ones before it answers with what it has and a cursor to go on. */
const STUCK_PAGES_MAX = 5;

/** A requeued fact is not given up on for this long, whatever its original expiry was: the sweep takes a pending row past it. */
const REQUEUED_HOLD_DAYS = 7;

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

/**
 * The rows of a page that are held and not stuck (D-353): of a consumer the build carries, in a workspace that is not granted it. A
 * consumer the build does not carry is not judged, since nothing of this version would deliver it: its row is stuck. Judged over the
 * whole build and not by what this node runs, so the list is the same whichever node answers it.
 */
const heldOf = async (
  database: Executor,
  view: Pick<OutboxView, 'consumers' | 'granted'>,
  rows: readonly Metadata[],
  now: Date,
): Promise<ReadonlySet<string>> => {
  const judged = rows.filter((row) => view.consumers.includes(row.consumer));
  const grants = await readGrants(database, [...new Set(judged.map((row) => row.workspace_id))]);
  return new Set(
    judged
      .filter((row) => !view.granted(grants.get(row.workspace_id) ?? [], now).has(row.consumer))
      .map((row) => row.id),
  );
};

/**
 * The facts asked for, oldest first by id (a UUIDv7), a page at a time. `dead` is the default: what needs a person. `stuck` is a
 * pending fact older than the overview's fifteen minutes that is not held on purpose and not past its expiry (D-353); its page reads
 * past held rows up to `STUCK_PAGES_MAX` pages, and may then be short with a cursor to go on.
 */
export const listOutboxFacts = async (
  database: Executor,
  query: ServerOutboxQuery,
  now: Date,
  view: Pick<OutboxView, 'consumers' | 'granted'>,
): Promise<ServerOutboxPage> => {
  const limit = query.limit ?? LIST_DEFAULT;
  const state = query.state ?? 'dead';
  const pageAfter = async (after: string | undefined): Promise<Metadata[]> => {
    let statement = database
      .selectFrom('outbox')
      .select(COLUMNS)
      .orderBy('id')
      .limit(limit + 1);
    statement =
      state === 'stuck'
        ? statement
            .where('state', '=', 'pending')
            .where('expires_at', '>', now)
            .where('created_at', '<', new Date(now.getTime() - OUTBOX_STALE_AFTER_SECONDS * 1000))
        : statement.where('state', '=', state);
    if (after !== undefined) statement = statement.where('id', '>', after);
    if (query.consumer !== undefined) statement = statement.where('consumer', '=', query.consumer);
    if (query.type !== undefined) statement = statement.where('type', '=', query.type);
    if (query.workspaceId !== undefined)
      statement = statement.where('workspace_id', '=', query.workspaceId);
    return await statement.execute();
  };
  if (state !== 'stuck') {
    const rows = await pageAfter(query.after);
    const data = rows.slice(0, limit).map(factOf);
    return { data, nextCursor: rows.length > limit ? (data.at(-1)?.id ?? null) : null };
  }
  const kept: Metadata[] = [];
  let after = query.after;
  for (let page = 0; page < STUCK_PAGES_MAX; page += 1) {
    const rows = await pageAfter(after);
    const held = await heldOf(database, view, rows, now);
    kept.push(...rows.filter((row) => !held.has(row.id)));
    if (kept.length > limit) break;
    if (rows.length <= limit) {
      const data = kept.map(factOf);
      return { data, nextCursor: null };
    }
    after = rows.at(-1)?.id;
  }
  const data = kept.slice(0, limit).map(factOf);
  return {
    data,
    nextCursor: kept.length > limit ? (data.at(-1)?.id ?? null) : (after ?? null),
  };
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

export type OutboxChange = 'requeue' | 'discard';
export type OutboxVerdict = 'changed' | 'unchanged' | 'refused' | 'not_found';

/** A delivery that was changed, as the trail needs it. */
export interface ChangedOutboxFact {
  readonly id: string;
  readonly factId: string;
  readonly workspaceId: string;
  readonly consumer: string;
}

const verdictOf = (
  change: OutboxChange,
  row: { readonly state: string; readonly attempts: number; readonly next_attempt_at: Date },
  now: Date,
): Exclude<OutboxVerdict, 'not_found'> => {
  // A delivery that is over is not brought back: a delivered fact was acted on, and acting twice is the fault this table prevents.
  if (row.state === 'delivered' || row.state === 'skipped') return 'refused';
  if (change === 'discard') return row.state === 'discarded' ? 'unchanged' : 'changed';
  const waitingFresh =
    row.state === 'pending' && row.attempts === 0 && row.next_attempt_at.getTime() <= now.getTime();
  return waitingFresh ? 'unchanged' : 'changed';
};

/**
 * Requeues (pending again, no tries used, due now) or discards (given up on, kept) the deliveries, in the caller's transaction.
 * The rows are locked in id order and judged under the lock, so two requests for one row take turns and the second finds it done
 * (`unchanged`), and a delivery in flight is waited for and then found delivered (`refused`). Writes nothing for a repeat.
 */
export const changeOutboxFacts = async (
  tx: Transaction,
  change: OutboxChange,
  ids: readonly string[],
  now: Date,
): Promise<{
  readonly verdicts: readonly { readonly id: string; readonly result: OutboxVerdict }[];
  readonly changed: readonly ChangedOutboxFact[];
}> => {
  const rows = await tx
    .selectFrom('outbox')
    .select(['id', 'fact_id', 'workspace_id', 'consumer', 'state', 'attempts', 'next_attempt_at'])
    .where('id', 'in', ids)
    .orderBy('id')
    .forUpdate()
    .execute();
  const found = new Map(rows.map((row) => [row.id, row]));
  const verdicts = ids.map((id) => {
    const row = found.get(id);
    return { id, result: row === undefined ? ('not_found' as const) : verdictOf(change, row, now) };
  });
  const changedRows = rows.filter((row) => verdictOf(change, row, now) === 'changed');
  if (changedRows.length > 0) {
    const where = changedRows.map((row) => row.id);
    await tx
      .updateTable('outbox')
      .set(
        change === 'discard'
          ? { state: 'discarded', finished_at: now }
          : {
              state: 'pending',
              attempts: 0,
              next_attempt_at: now,
              finished_at: null,
              expires_at: sql<Date>`greatest(expires_at, ${new Date(now.getTime() + REQUEUED_HOLD_DAYS * DAY_MS)})`,
            },
      )
      .where('id', 'in', where)
      .execute();
  }
  return {
    verdicts,
    changed: changedRows.map((row) => ({
      id: row.id,
      factId: row.fact_id,
      workspaceId: row.workspace_id,
      consumer: row.consumer,
    })),
  };
};
