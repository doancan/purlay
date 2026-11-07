/**
 * A module's handlers of the facts it consumes (`MODULES.md` §4, D-283 §3), one for each type named in its manifest's
 * `consumes` and keyed by it, as frame handlers are keyed by the operation they serve (`frame-handlers.ts`).
 *
 * What delivers a fact (D-287, step 14d): a handler runs in the consumer's own transaction, which the delivery's mark is
 * committed with, under the module's share and its `workerDeadline`.
 */
import type { Transaction } from '@purlay/db';

/** A fact as the consumer is given it: whose it is, which delivery it is, and the payload, checked against its declaration. */
interface DeliveredFact {
  readonly type: string;
  /** The same on every consumer's delivery of one fact: the consumer's idempotency key for an effect outside the database. */
  readonly factId: string;
  /** The workspace the fact was published in, which a payload's own ids are checked against. */
  readonly workspaceId: string;
  readonly payload: unknown;
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
) => Promise<'done' | 'skipped'>;

export type FactConsumers = Readonly<Record<string, FactConsumer>>;
