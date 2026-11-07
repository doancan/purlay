/**
 * A module's handlers of the facts it consumes (`MODULES.md` §4, D-283 §3), one for each type named in its manifest's
 * `consumes` and keyed by it, as frame handlers are keyed by the operation they serve (`frame-handlers.ts`).
 *
 * Only the shape of the thing is here: what delivers a fact, in whose transaction, and under what share and deadline arrives with
 * the step that builds the delivery, and widens a handler's arguments then.
 */

/** A fact as the consumer is given it: whose it is, which delivery it is, and the payload, checked against its declaration. */
interface DeliveredFact {
  readonly type: string;
  /** The same on every consumer's delivery of one fact: the consumer's idempotency key. */
  readonly factId: string;
  /** The workspace the fact was published in, which a payload's own ids are checked against. */
  readonly workspaceId: string;
  readonly payload: unknown;
}

export type FactConsumer = (fact: DeliveredFact) => Promise<void>;

export type FactConsumers = Readonly<Record<string, FactConsumer>>;
