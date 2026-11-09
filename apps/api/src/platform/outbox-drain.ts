/**
 * Taking facts out of the outbox and running them (`MODULES.md` §4, D-288, D-283 §2), in two steps that two nodes can run at once
 * without one fact being run by both.
 *
 * **Claim.** A short transaction picks the due rows of the (consumer, type) pairs this node has a handler for, of the shapes it
 * knows, by turns across workspaces so that none can fill every batch (`pickFairly`), takes them with `FOR UPDATE SKIP LOCKED`, adds one to `attempts` and puts `next_attempt_at` out by the backoff, and commits. A row
 * of a type or a shape this node does not know is not touched, so a rolling deploy leaves a newer node's facts for a node that can
 * read them. The attempt is counted here and not when the handler fails, so a fact whose handler hangs or kills its node still
 * reaches the ceiling and goes `dead`; the backoff is the lease, so a node that dies after the claim leaves a row that shows again.
 *
 * **Deliver.** For each claimed row the consumer's own transaction locks it, skips it if it is no longer pending, runs the
 * handler **in that transaction** under a savepoint and marks the row delivered. The handler's effects in the database and the mark
 * commit together or not at all, which makes them exactly once; an effect outside the database is at least once, keyed by `factId`.
 *
 * What this does not give is order. A consumer is written for a fact it sees twice and out of order.
 */
import { Value } from '@sinclair/typebox/value';
import { sql, type Executor } from '@purlay/db';
import { FACT_SHAPE_FIRST, type FactDeclaration } from '@purlay/types';
import type { Clock } from './clock';
import type { FactConsumer } from './fact-consumers';
import { currentRequest, withinRequest, type Logger } from './logging';
import { readGrants } from './grants';
import type { EntitlementPolicy } from './module-kit/entitlement';
import type { Counter } from './metrics';
import { noPorts, type ModulePorts } from './ports/module-ports';
import { noSeams, type ModuleSeams } from './ports/module-seams';
import type { WrittenNotice } from './ports/notification-sink';
import { mintTurn } from './workspace-turn';
import { atomicallyOn } from './transactions';

/** Tries a fact has before it is given up on as `dead`. Five seconds doubling, with jitter, is about twenty minutes (`backoffMs`). */
export const OUTBOX_ATTEMPTS_MAX = 8;

export const BACKOFF_FIRST_MS = 5_000;
export const BACKOFF_MAX_MS = 3_600_000;
const JITTER = 0.2;
/** What `last_error` says of a row that ran out of tries without a handler's word: a node that died on it, or a deadline. */
const EXHAUSTED = 'AttemptsExhausted';
const ERROR_MAX_CHARS = 300;

/** The wait before attempt `attempt` (the first is 1): doubling from five seconds to an hour, within 20% either way. */
export const backoffMs = (attempt: number, random: () => number = Math.random): number =>
  Math.round(
    Math.min(BACKOFF_FIRST_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS) *
      (1 - JITTER + 2 * JITTER * random()),
  );

/** What a node can read: a consumer's handler for a type, and the newest shape of that type's declaration it knows. */
export interface Handled {
  readonly consumer: string;
  readonly type: string;
  readonly shape: number;
}

/** A claimed row: what a delivery needs, and nothing the handler is not given. */
export interface ClaimedFact {
  readonly id: string;
  readonly factId: string;
  readonly type: string;
  readonly consumer: string;
}

export interface Claim {
  readonly claimed: readonly ClaimedFact[];
  /** Rows that had used every try without ending, now `dead`: a fact that kills what runs it ends here. */
  readonly exhausted: readonly ClaimedFact[];
}

/** An id no row has, for a pick that found nothing: `in ()` is not SQL. */
const NO_ROW = '00000000-0000-7000-8000-000000000000';

/**
 * How many workspaces a pick looks at for each place in the batch, so that those not granted the consumer, found once the grants are
 * read, leave room for the rest; and how many times the pick is made again without the ones found: some four hundred such
 * workspaces are passed over in a claim, and each round past the first costs the pick again.
 */
const PICK_WIDTH = 4;
const PICK_ROUNDS_MAX = 5;

interface Picked {
  readonly id: string;
  readonly workspaceId: string;
  readonly consumer: string;
  readonly rank: number;
  readonly dueAt: Date;
}

/**
 * The rows to claim, by turns across workspaces (D-288 §11): the `batch` workspaces whose oldest due row has waited longest, then
 * their rows oldest first, ranked within each workspace, taken by rank and then by age. A workspace with ten thousand facts has one
 * place in a batch while others have a fact waiting, and the whole batch when none does. Nothing is locked here; the claim does that.
 *
 * Workspaces are found by walking the index of the consumer's pending rows from one workspace to the next (a loose scan), so the
 * cost is a probe for each workspace that has anything pending and not a read of every row; a window over every due row is the
 * same answer, measured at 370 ms on 500,000 rows against 45 ms for this on 5,000 workspaces (`idx_outbox_pending_by_workspace`).
 */
const pickFairly = async (
  transaction: Executor,
  handles: readonly Handled[],
  batch: number,
  now: Date,
  excluded: readonly string[],
): Promise<Picked[]> => {
  const consumers = [...new Set(handles.map(({ consumer }) => consumer))];
  const picks: Picked[] = [];
  for (const consumer of consumers) {
    const known = sql.join(
      handles
        .filter((handle) => handle.consumer === consumer)
        .map((handle) => sql`(o.type = ${handle.type} and o.shape <= ${handle.shape})`),
      sql` or `,
    );
    const due = sql`o.consumer = ${consumer} and o.state = 'pending' and o.next_attempt_at <= ${now}
      and o.expires_at > ${now} and (${known}) and o.workspace_id <> all(${excluded}::uuid[])`;
    const { rows } = await sql<{ id: string; workspace_id: string; rank: string; due_at: Date }>`
      with recursive spaces(workspace_id) as (
        (select workspace_id from outbox where consumer = ${consumer} and state = 'pending' order by workspace_id limit 1)
        union all
        select (select o.workspace_id from outbox o where o.consumer = ${consumer} and o.state = 'pending'
                  and o.workspace_id > spaces.workspace_id order by o.workspace_id limit 1)
        from spaces where spaces.workspace_id is not null
      ), chosen as (
        select s.workspace_id, head.next_attempt_at
        from spaces s cross join lateral (
          select o.next_attempt_at from outbox o where ${due} and o.workspace_id = s.workspace_id
          order by o.next_attempt_at limit 1) head
        where s.workspace_id is not null
        order by head.next_attempt_at limit ${batch * PICK_WIDTH}
      )
      select r.id, c.workspace_id, r.next_attempt_at as due_at,
             row_number() over (partition by c.workspace_id order by r.next_attempt_at, r.id) as rank
      from chosen c cross join lateral (
        select o.id, o.next_attempt_at from outbox o where ${due} and o.workspace_id = c.workspace_id
        order by o.next_attempt_at, o.id limit ${batch}) r`.execute(transaction);
    picks.push(
      ...rows.map((row) => ({
        id: row.id,
        workspaceId: row.workspace_id,
        consumer,
        rank: Number(row.rank),
        dueAt: row.due_at,
      })),
    );
  }
  return picks.sort(
    (a, b) => a.rank - b.rank || a.dueAt.getTime() - b.dueAt.getTime() || (a.id < b.id ? -1 : 1),
  );
};

/**
 * Takes up to `batch` of the due rows this node can read for one delivery each. Two nodes calling at once take different rows.
 * `effective` is the composition's function of workspace grants (D-289): a row of a workspace that is not granted the consumer
 * stays as it is, untouched, for when it is, and the work of a module a workspace lost is not done for it.
 */
export const claimDue = async (
  database: Executor,
  input: {
    readonly handles: readonly Handled[];
    readonly batch: number;
    readonly clock: Clock;
    readonly random?: () => number;
    readonly effective?: EntitlementPolicy['effective'];
  },
): Promise<Claim> => {
  const { handles, batch, clock, random, effective } = input;
  if (handles.length === 0) return { claimed: [], exhausted: [] };
  return await atomicallyOn(database)(async (transaction) => {
    const now = clock.now();
    // A workspace that is not granted the consumer is left out of the pick before anything is locked, so its rows, however many and
    // however old, hold no place in a batch; they are as they were for when it is granted.
    const granted = new Map<string, ReadonlySet<string>>();
    const mayUse = (workspaceId: string, consumer: string): boolean =>
      effective === undefined || (granted.get(workspaceId)?.has(consumer) ?? false);
    let excluded: string[] = [];
    let picked: Picked[] = [];
    for (let round = 0; round < PICK_ROUNDS_MAX; round += 1) {
      picked = await pickFairly(transaction, handles, batch, now, excluded);
      if (effective === undefined) break;
      const unknown = [...new Set(picked.map((row) => row.workspaceId))].filter(
        (id) => !granted.has(id),
      );
      const grants = await readGrants(transaction, unknown);
      for (const id of unknown) granted.set(id, effective(grants.get(id) ?? [], now));
      const barred = picked.filter((row) => !mayUse(row.workspaceId, row.consumer));
      picked = picked.filter((row) => mayUse(row.workspaceId, row.consumer));
      // Enough granted rows for a batch, or no workspace left that was not looked at: the pick is as good as it will be.
      if (barred.length === 0 || picked.length >= batch) break;
      excluded = [...excluded, ...new Set(barred.map((row) => row.workspaceId))];
    }
    picked = picked.slice(0, batch);
    const ids = picked.map((row) => row.id);
    const locked = await transaction
      .selectFrom('outbox')
      .select(['id', 'fact_id', 'type', 'consumer', 'attempts', 'workspace_id'])
      .where('id', 'in', ids.length === 0 ? [NO_ROW] : ids)
      // The pick took no lock, so this takes them and asks again whether they are still due: a row another node claimed in
      // between is leased by now and drops out here, or is held and skipped. (Its expiry and its type do not change.)
      .where('state', '=', 'pending')
      .where('next_attempt_at', '<=', now)
      .forUpdate()
      .skipLocked()
      .execute();
    const placeOf = new Map(ids.map((id, place) => [id, place]));
    const due = locked.sort((a, b) => (placeOf.get(a.id) ?? 0) - (placeOf.get(b.id) ?? 0));
    const claimed: ClaimedFact[] = [];
    const exhausted: ClaimedFact[] = [];
    for (const row of due) {
      const fact = { id: row.id, factId: row.fact_id, type: row.type, consumer: row.consumer };
      const spent = row.attempts >= OUTBOX_ATTEMPTS_MAX;
      await transaction
        .updateTable('outbox')
        .set(
          spent
            ? { state: 'dead', finished_at: now, last_error: EXHAUSTED }
            : {
                attempts: row.attempts + 1,
                next_attempt_at: new Date(now.getTime() + backoffMs(row.attempts + 1, random)),
              },
        )
        .where('id', '=', row.id)
        .execute();
      (spent ? exhausted : claimed).push(fact);
    }
    return { claimed, exhausted };
  });
};

/** What a delivery came to. `gone` is a row another node delivered or holds: nothing is done and nothing is owed. */
export type Delivery = 'delivered' | 'skipped' | 'failed' | 'dead' | 'gone';

export interface FactHandling {
  readonly declaration: FactDeclaration;
  readonly handle: FactConsumer;
}

/** What is said of a failure, and all that is: its class, never the message, which a database error fills with the row's values. */
const errorClass = (error: unknown): string => {
  if (!(error instanceof Error)) return 'UnknownError';
  const code: unknown = 'code' in error ? error.code : undefined;
  const text = typeof code === 'string' ? `${error.name}:${code}` : error.name;
  return text.slice(0, ERROR_MAX_CHARS);
};

/**
 * A row's payload in the declaration's current shape (D-288 §5): checked against the schema of the shape the row was written in
 * and, when that is an earlier one, upgraded by its reader. `undefined` is a payload that is not going to get better: it does not
 * fit its own shape, no reader describes that shape, or the upgrade throws or makes something the current shape refuses.
 */
const readAsCurrentShape = (
  declaration: FactDeclaration,
  shape: number,
  payload: unknown,
): { readonly payload: unknown } | undefined => {
  if (shape === (declaration.shape ?? FACT_SHAPE_FIRST)) {
    return Value.Check(declaration.schema, payload) ? { payload } : undefined;
  }
  const reader = declaration.reads?.[shape];
  if (reader === undefined || !Value.Check(reader.schema, payload)) return undefined;
  let upgraded: unknown;
  try {
    upgraded = reader.upcast(payload);
  } catch {
    // The same row would throw again, and the line of its death says which fact; the payload is never quoted.
    return undefined;
  }
  return Value.Check(declaration.schema, upgraded) ? { payload: upgraded } : undefined;
};

/** Delivers one claimed row in the consumer's transaction, and says what came of it. A row whose handler threw is left for its backoff. */
export const deliver = async (
  database: Executor,
  claimed: ClaimedFact,
  handling: FactHandling,
  dependencies: {
    readonly clock: Clock;
    readonly log: Logger;
    readonly ports?: ModulePorts;
    readonly seams?: ModuleSeams;
    readonly effective?: EntitlementPolicy['effective'];
  },
): Promise<Delivery> => {
  const { clock, ports = noPorts, seams = noSeams, effective } = dependencies;
  let told: readonly WrittenNotice[] = [];
  let log = dependencies.log;
  const outcome = await atomicallyOn(database)(async (transaction): Promise<Delivery> => {
    const row = await transaction
      .selectFrom('outbox')
      .select(['workspace_id', 'payload', 'attempts', 'shape', 'correlation_id'])
      .where('id', '=', claimed.id)
      .where('state', '=', 'pending')
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (row === undefined) return 'gone';
    // The request that published it speaks on every line of its delivery, so a log follows the chain; none, a fresh id.
    const correlationId =
      row.correlation_id ?? currentRequest()?.requestId ?? `fact:${claimed.factId}`;
    log = dependencies.log.child({
      fact: claimed.type,
      factId: claimed.factId,
      consumer: claimed.consumer,
      correlationId,
    });
    const finish = async (
      state: 'delivered' | 'skipped' | 'dead',
      lastError: string | null,
    ): Promise<Delivery> => {
      await transaction
        .updateTable('outbox')
        .set({ state, finished_at: clock.now(), last_error: lastError })
        .where('id', '=', claimed.id)
        .execute();
      return state;
    };
    // Checked again here, against the shape the row was written in: a rolling deploy leaves a newer node rows an older one
    // published, which only an earlier shape's schema fits. (A shape it does not know is not claimed, so it is not here.)
    const read = readAsCurrentShape(handling.declaration, row.shape, row.payload);
    if (read === undefined) return await finish('dead', 'PayloadRefused');
    const modules =
      effective === undefined
        ? null
        : effective(
            (await readGrants(transaction, [row.workspace_id])).get(row.workspace_id) ?? [],
            clock.now(),
          );
    const bound = seams.bind(
      transaction,
      mintTurn({ workspaceId: row.workspace_id, modules }),
      claimed.factId,
    );
    await sql`savepoint fact_handler`.execute(transaction);
    let result: Awaited<ReturnType<FactConsumer>>;
    try {
      const request = currentRequest();
      result = await withinRequest(
        {
          startedAt: performance.now(),
          ...request,
          requestId: correlationId,
          module: claimed.consumer,
        },
        async () =>
          await handling.handle(
            {
              type: claimed.type,
              factId: claimed.factId,
              workspaceId: row.workspace_id,
              modules,
              correlationId,
              payload: read.payload,
            },
            transaction,
            ports,
            bound.seam,
          ),
      );
    } catch (error) {
      await sql`rollback to savepoint fact_handler`.execute(transaction);
      const failure = errorClass(error);
      if (row.attempts < OUTBOX_ATTEMPTS_MAX) {
        await transaction
          .updateTable('outbox')
          .set({ last_error: failure })
          .where('id', '=', claimed.id)
          .execute();
        log.warn('a fact was not delivered; it is tried again', {
          attempts: row.attempts,
          failure,
        });
        return 'failed';
      }
      return await finish('dead', failure);
    }
    // Outside the try: a failure of the mark is not the handler's, and ends the transaction with the effect in it.
    await sql`release savepoint fact_handler`.execute(transaction);
    told = bound.written();
    return await finish(result === 'skipped' ? 'skipped' : 'delivered', null);
  });
  // After the commit: a notice is told only if what it is about is, and a line about a death is not said for a transaction that then fails.
  if (outcome === 'delivered' || outcome === 'skipped') await seams.announce(told);
  if (outcome === 'dead') log.error('a fact is dead and will not be delivered');
  return outcome;
};

/** What a drain counts: the facts delivered and the deliveries that failed or were given up on, by module and fact type. */
export interface OutboxCounters {
  readonly delivered: Counter<'module' | 'fact'>;
  readonly failures: Counter<'module' | 'fact'>;
}

/** One drain: a claim and the delivery of what it took, in the order claimed. The work of a consumer's worker. */
export const drainOnce = async (
  database: Executor,
  input: {
    readonly handlers: readonly (Handled & FactHandling)[];
    readonly batch: number;
    readonly clock: Clock;
    readonly log: Logger;
    readonly effective?: EntitlementPolicy['effective'];
    readonly counters?: OutboxCounters;
    readonly ports?: ModulePorts;
    readonly seams?: ModuleSeams;
  },
): Promise<Record<Delivery | 'exhausted', number>> => {
  const { handlers, batch, clock, log, effective, counters, ports, seams } = input;
  const tally = { delivered: 0, skipped: 0, failed: 0, dead: 0, gone: 0, exhausted: 0 };
  const { claimed, exhausted } = await claimDue(database, {
    handles: handlers,
    batch,
    clock,
    ...(effective === undefined ? {} : { effective }),
  });
  tally.exhausted = exhausted.length;
  for (const one of exhausted) {
    log.error('a fact is dead and will not be delivered', {
      fact: one.type,
      factId: one.factId,
      consumer: one.consumer,
    });
    counters?.failures.inc({ module: one.consumer, fact: one.type });
  }
  for (const one of claimed) {
    const handling = handlers.find(
      (candidate) => candidate.consumer === one.consumer && candidate.type === one.type,
    );
    if (handling === undefined) continue;
    const outcome = await deliver(database, one, handling, {
      clock,
      log,
      ...(ports === undefined ? {} : { ports }),
      ...(seams === undefined ? {} : { seams }),
      ...(effective === undefined ? {} : { effective }),
    });
    tally[outcome] += 1;
    const labels = { module: one.consumer, fact: one.type };
    if (outcome === 'delivered') counters?.delivered.inc(labels);
    if (outcome === 'failed' || outcome === 'dead') counters?.failures.inc(labels);
  }
  return tally;
};
