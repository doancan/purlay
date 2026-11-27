/**
 * A module's handlers of the facts it consumes (`MODULES.md` §4, D-283 §3), one for each type named in its manifest's
 * `consumes` and keyed by it, as frame handlers are keyed by the operation they serve (`frame-handlers.ts`).
 *
 * What delivers a fact (D-288, step 14d): a handler runs in the consumer's own transaction, which the delivery's mark is
 * committed with, under the module's share and its `workerDeadline`.
 */
import type { Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Transaction } from '@purlay/db';
import type { FactDeclaration } from '@purlay/types';
import type { ModulePorts } from './ports/module-ports';
import type { WorkspaceSeam } from './ports/module-seams';

/** A fact as the consumer is given it: whose it is, which delivery it is, and the payload, checked against its declaration. */
export interface DeliveredFact<Payload = unknown> {
  readonly type: string;
  /** The same on every consumer's delivery of one fact: the consumer's idempotency key for an effect outside the database. */
  readonly factId: string;
  /** The workspace the fact was published in, which a payload's own ids are checked against. */
  readonly workspaceId: string;
  /**
   * The modules the workspace may use as the delivery read its grants (`null` where nothing judged them): with `workspaceId`, what
   * `ports.of(fact)` asks, so a consumer cannot reach a port of a module the workspace has lost.
   */
  readonly modules: ReadonlySet<string> | null;
  /** The request that published the fact (or a stand-in): the id its delivery's log lines carry, and what a fact it publishes carries on. */
  readonly correlationId: string;
  /** In the declaration's current shape, whatever shape the row was written in (D-288 §5). */
  readonly payload: Payload;
}

/**
 * `'done'`, or `'skipped'` for a fact it read and chose not to act on (a channel that is gone): both are an end, and neither is
 * tried again. A throw is a failure, tried again at the backoff until the ceiling.
 *
 * The handler is delivered more than once if its node dies after the effect and before the commit, and in no order, so it is
 * written for a fact it sees twice. Its effects in the database are in `transaction` and are undone with a throw.
 */
export type FactConsumer = (
  fact: DeliveredFact,
  transaction: Transaction,
  /** The consumer's ports (`uses`), reading through the consumer's own share of the pool. */
  ports: ModulePorts,
  /**
   * Tells the rest of the build something from this delivery, as the consumer's module and for the fact's workspace: a notice with
   * no actor and a follow-up fact, both in `transaction` and so undone with a throw. Notices are announced once the delivery has
   * committed. A follow-up fact says it is a consequence of this one, and a chain of them is bounded.
   */
  seam: WorkspaceSeam,
) => Promise<'done' | 'skipped'>;

export type FactConsumers = Readonly<Record<string, FactConsumer>>;

/** A handler of one declared fact, whose payload is typed by the declaration's schema. */
export type FactHandler<Fact extends FactDeclaration> = (
  fact: DeliveredFact<Static<Fact['schema']>>,
  transaction: Transaction,
  ports: ModulePorts,
  seam: WorkspaceSeam,
) => Promise<'done' | 'skipped'>;

/**
 * The handler of `fact`, keyed by its type, for a slot's `factConsumers` (`{ ...consumerOf(A, onA), ...consumerOf(B, onB) }`): the
 * handler is given the payload typed by the declaration, so a module's code needs no cast. The delivery has already checked the payload
 * against that schema; it is asked again here, as a type guard, and a payload that fails is a throw (tried again, then dead), never a
 * value of the wrong type in the handler.
 */
export const consumerOf = <Fact extends FactDeclaration>(
  fact: Fact,
  handle: FactHandler<Fact>,
): FactConsumers => ({
  [fact.type]: async (delivered, transaction, ports, seam): ReturnType<FactConsumer> => {
    const { payload } = delivered;
    if (!Value.Check(fact.schema, payload)) {
      throw new TypeError(`the payload of "${fact.type}" does not fit its declaration`);
    }
    return await handle({ ...delivered, payload }, transaction, ports, seam);
  },
});
