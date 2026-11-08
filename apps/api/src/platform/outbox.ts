/**
 * Telling another module a fact, in the transaction that made it true (`MODULES.md` §4, D-288, D-283 §2).
 *
 * A fact is written to the outbox as one row for each module of the build that consumes it, so a fact exists exactly when what
 * it reports does: rolled back with the publisher's transaction, committed with it. `outbox-drain.ts`, which delivers it (D-288), is
 * the only other place the table will be named.
 *
 * The outbox is for facts of human scale (an assignment, a link): a fact is never one for each message, which has a path of its
 * own (D-35). A fact names ids and a short label and not a state, and its payload is checked against its declaration here and
 * again where it is delivered, since a payload is a contract between two modules that can be on two versions.
 */
import { Value } from '@sinclair/typebox/value';
import { type Static } from '@sinclair/typebox';
import { FACT_SHAPE_FIRST, messageId, type FactDeclaration } from '@purlay/types';
import { isTransaction, sql, type Transaction } from '@purlay/db';
import { DAY_MS, type Clock } from './clock';
import { readGrants } from './grants';
import { currentRequest } from './logging';
import type { Counter } from './metrics';
import type { EntitlementPolicy } from './module-kit/entitlement';
import type { ModuleManifest } from './module-kit/manifest';

/** Of compact JSON: the table's own check is the backstop, since `jsonb` writes a space after each separator. */
export const OUTBOX_PAYLOAD_BYTES_MAX = 8192;

/** How long a row of a fact that is dropped when its consumer is off waits for a consumer that is on: a notice that late is wrong. */
const DROPPING_FACT_PENDING_DAYS = 1;

/** The table's own limit: a request id may come from a header. */
const CORRELATION_ID_MAX = 64;

/** Who consumes what, for the modules a build carries, and which of them this process runs. Built from the manifests, once. */
export interface FactRouting {
  /** Every module the build carries that consumes the type, run or not, so every node of one version agrees on the list. */
  readonly consumersOf: (type: string) => readonly string[];
  readonly runs: (module: string) => boolean;
  /** Whether the module lists the type under `publishes`; the core may publish what it owns. */
  readonly mayPublish: (producer: string, type: string) => boolean;
}

export const factRoutingOf = (
  carried: readonly Pick<ModuleManifest, 'id' | 'publishes' | 'consumes'>[],
  running: readonly Pick<ModuleManifest, 'id'>[],
): FactRouting => ({
  consumersOf: (type) =>
    carried.filter((module) => (module.consumes ?? []).includes(type)).map(({ id }) => id),
  runs: (module) => running.some(({ id }) => id === module),
  mayPublish: (producer, type) =>
    producer === 'core' ||
    carried.some(({ id, publishes }) => id === producer && (publishes ?? []).includes(type)),
});

export interface FactPublishContext {
  readonly workspaceId: string;
  readonly clock: Clock;
  /** The module that publishes, or `core`: who the caller says it is, held to the module whose request this is. */
  readonly producer: string;
  readonly routing: FactRouting;
  /** `purlay_outbox_dropped_total`: a fact whose consumer is not run here and which is not held. */
  readonly dropped: Counter<'module' | 'fact'>;
  /** `purlay_outbox_refused_total`: a fact not written because its consumer's backlog in the workspace is full. */
  readonly refused: Counter<'module' | 'fact'>;
  /** The most rows one workspace may have pending for one consumer (`OUTBOX_PENDING_MAX`): a publish that would pass it is refused. */
  readonly pendingMax: number;
  /** The fact whose delivery is publishing this one, when one is: the chain from a fact to the facts it caused. */
  readonly causedBy?: string;
  /**
   * The composition's function of workspace grants (D-289): a consumer the workspace is not granted gets no row, since nobody
   * would deliver it and a grant given later is not a reason to act on what was said before it.
   */
  readonly effective?: EntitlementPolicy['effective'];
}

/** A fact that could not be published: a programming error, which ends the publisher's transaction and so leaves nothing of the fact. */
export class FactPublishError extends Error {
  constructor(type: string, reason: string) {
    super(`The fact "${type}" was not published: ${reason}.`);
    this.name = 'FactPublishError';
  }
}

/**
 * A fact that was not published because the workspace already has the most the consumer may wait for (D-288 §10). Unlike
 * `FactPublishError` it is not a defect of the publisher: the consumer is behind, or a loop is publishing in a flood. Nothing was
 * written, and a publisher that does not catch it ends its transaction and so leaves nothing of what the fact reports; one that
 * does catch it holds a transaction that is still usable and decides for itself. The fact is never dropped in silence.
 */
export class FactBacklogFull extends Error {
  readonly type: string;
  readonly workspaceId: string;
  readonly consumer: string;
  readonly ceiling: number;

  constructor(input: {
    readonly type: string;
    readonly workspaceId: string;
    readonly consumer: string;
    readonly ceiling: number;
  }) {
    super(
      `The fact "${input.type}" was not published: workspace ${input.workspaceId} already has ${String(input.ceiling)} facts waiting for "${input.consumer}", the most it may.`,
    );
    this.name = 'FactBacklogFull';
    this.type = input.type;
    this.workspaceId = input.workspaceId;
    this.consumer = input.consumer;
    this.ceiling = input.ceiling;
  }
}

const invalidReason = (fact: FactDeclaration, payload: unknown): string | undefined => {
  if (!Value.Check(fact.schema, payload)) {
    // The path and the rule, never the value: a payload is not for a log.
    const first = Value.Errors(fact.schema, payload).First();
    return `its payload does not fit its declaration (${first?.path ?? '/'}: ${first?.message ?? 'refused'})`;
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).length;
  return bytes > OUTBOX_PAYLOAD_BYTES_MAX
    ? `its payload is ${String(bytes)} bytes, past ${String(OUTBOX_PAYLOAD_BYTES_MAX)}`
    : undefined;
};

/**
 * Counts, up to the ceiling and no further, what the workspace has pending for each consumer about to get a row, and refuses the
 * whole fact if any is at it. A soft ceiling: two publishes in flight at once may both pass, by the number in flight and no more.
 */
const refuseWhenBacklogFull = async (
  transaction: Transaction,
  input: {
    readonly workspaceId: string;
    readonly type: string;
    readonly written: readonly string[];
    readonly pendingMax: number;
    readonly refused: Counter<'module' | 'fact'>;
  },
): Promise<void> => {
  const { workspaceId, type, written, pendingMax, refused } = input;
  const full: string[] = [];
  for (const consumer of written) {
    const { count } = await transaction
      .selectFrom(
        transaction
          .selectFrom('outbox')
          .select(sql<number>`1`.as('one'))
          .where('workspace_id', '=', workspaceId)
          .where('consumer', '=', consumer)
          .where('state', '=', 'pending')
          .limit(pendingMax)
          .as('waiting'),
      )
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .executeTakeFirstOrThrow();
    if (Number(count) >= pendingMax) full.push(consumer);
  }
  const [first] = full;
  if (first === undefined) return;
  for (const consumer of full) refused.inc({ module: consumer, fact: type });
  throw new FactBacklogFull({ type, workspaceId, consumer: first, ceiling: pendingMax });
};

/**
 * Writes the fact for each module that consumes it, in the caller's transaction, which a pool is not: `Transaction` is the type
 * of one, so a publish with nothing to roll back with does not compile.
 *
 * A consumer that is not run by this process is a row all the same when the fact says `holdDays`, for any node that runs it
 * to deliver, and no row when it says `drop`, with a count that says so. A fact nobody consumes writes nothing.
 */
export const publishFact = async <Fact extends FactDeclaration>(
  transaction: Transaction,
  context: FactPublishContext,
  fact: Fact,
  payload: Static<Fact['schema']>,
): Promise<void> => {
  const {
    workspaceId,
    clock,
    producer,
    routing,
    dropped,
    refused,
    pendingMax,
    causedBy,
    effective,
  } = context;
  // The type says it, and a cast could unsay it: a fact written with nothing to roll back with outlives the thing it reports.
  if (!isTransaction(transaction))
    throw new FactPublishError(fact.type, 'it is not in a transaction');
  const requestScope = currentRequest();
  const requestModule = requestScope?.module;
  if (fact.owner !== producer || !routing.mayPublish(producer, fact.type)) {
    throw new FactPublishError(fact.type, `"${producer}" is not its publisher`);
  }
  if (requestModule !== undefined && requestModule !== producer) {
    throw new FactPublishError(
      fact.type,
      `it is published as "${producer}" in a request of "${requestModule}"`,
    );
  }
  const invalid = invalidReason(fact, payload);
  if (invalid !== undefined) throw new FactPublishError(fact.type, invalid);

  const now = clock.now();
  const factId = messageId(now);
  const holdDays = typeof fact.absent === 'object' ? fact.absent.holdDays : undefined;
  const expiresAt = new Date(now.getTime() + (holdDays ?? DROPPING_FACT_PENDING_DAYS) * DAY_MS);
  const granted =
    effective === undefined
      ? undefined
      : effective((await readGrants(transaction, [workspaceId])).get(workspaceId) ?? [], now);
  const consumers = routing.consumersOf(fact.type).filter(
    // A consumer this process does not run is judged where it is run, at its delivery: the set holds the modules run here.
    (consumer) => granted === undefined || !routing.runs(consumer) || granted.has(consumer),
  );
  const written = consumers.filter((consumer) => routing.runs(consumer) || holdDays !== undefined);
  for (const consumer of consumers.filter((one) => !written.includes(one))) {
    dropped.inc({ module: consumer, fact: fact.type });
  }
  if (written.length === 0) return;
  await refuseWhenBacklogFull(transaction, {
    workspaceId,
    type: fact.type,
    written,
    pendingMax,
    refused,
  });
  await transaction
    .insertInto('outbox')
    .values(
      written.map((consumer) => ({
        id: messageId(now),
        fact_id: factId,
        workspace_id: workspaceId,
        type: fact.type,
        producer,
        consumer,
        payload: JSON.stringify(payload),
        next_attempt_at: now,
        created_at: now,
        expires_at: expiresAt,
        shape: fact.shape ?? FACT_SHAPE_FIRST,
        correlation_id: requestScope?.requestId.slice(0, CORRELATION_ID_MAX) ?? null,
        caused_by: causedBy ?? null,
      })),
    )
    .execute();
};

/**
 * One batch of a purged workspace's undelivered and delivered rows. The workspace's own row stays as a tombstone, so its key's
 * cascade never fires (D-242): the purge takes these itself. Returns how many it took; a short batch is the last.
 */
export const purgeWorkspaceFacts = async (
  transaction: Transaction,
  workspaceId: string,
  limit: number,
): Promise<number> => {
  const gone = await transaction
    .deleteFrom('outbox')
    .where(
      'id',
      'in',
      transaction
        .selectFrom('outbox')
        .select('id')
        .where('workspace_id', '=', workspaceId)
        .limit(limit),
    )
    .returning('id')
    .execute();
  return gone.length;
};
