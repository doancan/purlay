/**
 * Telling another module a fact, in the transaction that made it true (`MODULES.md` §4, D-288, D-283 §2).
 *
 * A fact is written to the outbox as one row for each module of the build that consumes it, so a fact exists exactly when what
 * it reports does: rolled back with the publisher's transaction, committed with it. The step that delivers it (D-288, 14d) is
 * the only other place the table will be named.
 *
 * The outbox is for facts of human scale (an assignment, a link): a fact is never one for each message, which has a path of its
 * own (D-35). A fact names ids and a short label and not a state, and its payload is checked against its declaration here and
 * again where it is delivered, since a payload is a contract between two modules that can be on two versions.
 */
import { Value } from '@sinclair/typebox/value';
import { type Static } from '@sinclair/typebox';
import { FACT_SHAPE_FIRST, messageId, type FactDeclaration } from '@purlay/types';
import { isTransaction, type Transaction } from '@purlay/db';
import { DAY_MS, type Clock } from './clock';
import { currentRequest } from './logging';
import type { Counter } from './metrics';
import type { ModuleManifest } from './module-kit/manifest';

/** Of compact JSON: the table's own check is the backstop, since `jsonb` writes a space after each separator. */
export const OUTBOX_PAYLOAD_BYTES_MAX = 8192;

/** How long a row of a fact that is dropped when its consumer is off waits for a consumer that is on: a notice that late is wrong. */
const DROPPING_FACT_PENDING_DAYS = 1;

/** The table's own limit: a request id may come from a header. */
const CORRELATION_ID_MAX = 64;

const ALWAYS_ENTITLED = (): boolean => true;

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
  /** The fact whose delivery is publishing this one, when one is: the chain from a fact to the facts it caused. */
  readonly causedBy?: string;
  /**
   * Whether the workspace may use the module (D-250 rule 9, which is not built): a consumer it may not use gets no row. Always
   * true until workspace-level enablement exists, and a seam for it and not a policy.
   */
  readonly entitled?: (workspaceId: string, module: string) => boolean;
}

/** A fact that could not be published: a programming error, which ends the publisher's transaction and so leaves nothing of the fact. */
export class FactPublishError extends Error {
  constructor(type: string, reason: string) {
    super(`The fact "${type}" was not published: ${reason}.`);
    this.name = 'FactPublishError';
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
  const { workspaceId, clock, producer, routing, dropped, causedBy } = context;
  const entitled = context.entitled ?? ALWAYS_ENTITLED;
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
  const consumers = routing
    .consumersOf(fact.type)
    .filter((consumer) => entitled(workspaceId, consumer));
  const written = consumers.filter((consumer) => routing.runs(consumer) || holdDays !== undefined);
  for (const consumer of consumers.filter((one) => !written.includes(one))) {
    dropped.inc({ module: consumer, fact: fact.type });
  }
  if (written.length === 0) return;
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
