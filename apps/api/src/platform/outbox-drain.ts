/**
 * Taking facts out of the outbox and running them (`MODULES.md` §4, D-288, D-283 §2), in two steps that two nodes can run at once
 * without one fact being run by both.
 *
 * **Claim.** A short transaction takes the due rows of the (consumer, type) pairs this node has a handler for, of the shapes it
 * knows, with `FOR UPDATE SKIP LOCKED`, adds one to `attempts` and puts `next_attempt_at` out by the backoff, and commits. A row
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
import { atomicallyOn } from './transactions';

/** Tries a fact has before it is given up on as `dead`. Five seconds doubling, with jitter, is about two hours (`backoffMs`). */
export const OUTBOX_ATTEMPTS_MAX = 8;

const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 3_600_000;
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
    const due = await transaction
      .selectFrom('outbox')
      .select(['id', 'fact_id', 'type', 'consumer', 'attempts', 'workspace_id'])
      .where((eb) =>
        eb.or(
          handles.map((handle) =>
            eb.and([
              eb('consumer', '=', handle.consumer),
              eb('type', '=', handle.type),
              eb('shape', '<=', handle.shape),
            ]),
          ),
        ),
      )
      .where('state', '=', 'pending')
      .where('next_attempt_at', '<=', now)
      .where('expires_at', '>', now)
      .orderBy('next_attempt_at')
      .limit(batch)
      .forUpdate()
      .skipLocked()
      .execute();
    const grants =
      effective === undefined
        ? undefined
        : await readGrants(transaction, [...new Set(due.map((row) => row.workspace_id))]);
    const granted = new Map<string, ReadonlySet<string>>();
    const mayUse = (workspaceId: string, consumer: string): boolean => {
      if (effective === undefined || grants === undefined) return true;
      let modules = granted.get(workspaceId);
      if (modules === undefined) {
        modules = effective(grants.get(workspaceId) ?? [], now);
        granted.set(workspaceId, modules);
      }
      return modules.has(consumer);
    };
    const claimed: ClaimedFact[] = [];
    const exhausted: ClaimedFact[] = [];
    for (const row of due) {
      if (!mayUse(row.workspace_id, row.consumer)) continue;
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

/** Delivers one claimed row in the consumer's transaction, and says what came of it. A row whose handler threw is left for its backoff. */
export const deliver = async (
  database: Executor,
  claimed: ClaimedFact,
  handling: FactHandling,
  dependencies: { readonly clock: Clock; readonly log: Logger },
): Promise<Delivery> => {
  const { clock } = dependencies;
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
    // Checked again here: a payload of a shape this node knows that does not fit it is never going to. (A shape it does not know
    // is not claimed, so it is not here.)
    if (
      row.shape > (handling.declaration.shape ?? FACT_SHAPE_FIRST) ||
      !Value.Check(handling.declaration.schema, row.payload)
    ) {
      return await finish('dead', 'PayloadRefused');
    }
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
              correlationId,
              payload: row.payload,
            },
            transaction,
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
    return await finish(result === 'skipped' ? 'skipped' : 'delivered', null);
  });
  // After the commit: a line about a death is not said for a transaction that then fails.
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
  },
): Promise<Record<Delivery | 'exhausted', number>> => {
  const { handlers, batch, clock, log, effective, counters } = input;
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
    const outcome = await deliver(database, one, handling, { clock, log });
    tally[outcome] += 1;
    const labels = { module: one.consumer, fact: one.type };
    if (outcome === 'delivered') counters?.delivered.inc(labels);
    if (outcome === 'failed' || outcome === 'dead') counters?.failures.inc(labels);
  }
  return tally;
};
