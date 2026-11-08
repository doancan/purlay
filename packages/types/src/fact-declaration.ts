/**
 * What a fact declaration is, apart from the lists of them: a module's own `<ID>_FACTS` (`<id>.ts`) is declared with
 * `defineFact` and joined to `FACTS` in `facts.ts`, so the two cannot be one file, or the first module's list would import
 * the file that imports it (`Cannot access 'defineFact' before initialization`).
 */
import type { TSchema } from '@sinclair/typebox';

/**
 * The most days a fact is held for a consumer that is not run: the outbox keeps a row no longer than it would have a person wait
 * for a module to be turned back on (D-288).
 */
export const FACT_HOLD_DAYS_MAX = 14;

/** The shape a declaration has until it says another. */
export const FACT_SHAPE_FIRST = 1;

/** What the publisher does about a consumer its process does not run: write no row, or write it and let any node that runs it deliver. */
export type FactAbsence = 'drop' | { readonly holdDays: number };

export interface FactDeclaration<Payload extends TSchema = TSchema> {
  /** `<owner>.<what>`. */
  readonly type: string;
  /** `core` or a module id: the one party that may publish it. */
  readonly owner: string;
  /** The shape of the payload, checked where it is published and where it is delivered. */
  readonly schema: Payload;
  /** What becomes of the fact where its consumer is not run, which only the declaration can say: the publisher does not know the consumer. */
  readonly absent: FactAbsence;
  /**
   * The version of the payload's shape, from 1. Adding an optional field leaves it; anything an older node would refuse (a new
   * required field, a value more in an enum, a narrower bound) raises it, so a node that does not know the shape leaves the row
   * for one that does and a rolling deploy kills nothing (D-288). Dropping a shape needs the release exception of a dropped type.
   */
  readonly shape?: number;
}

export const defineFact = <Payload extends TSchema>(
  declaration: FactDeclaration<Payload>,
): FactDeclaration<Payload> => declaration;
