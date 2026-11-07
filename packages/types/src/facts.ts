/**
 * What a module tells the build happened, as a type with a payload (`MODULES.md` §4, D-283 §3).
 *
 * A fact carries the ids of what changed and a short label, never its state: whoever consumes it reads the state itself.
 * The declarations live here and not in a module's folder because a module binds to the contract and not to another module,
 * and the payload is a wire shape (`CONTRIBUTING.md` §1.4). A type is named `<owner>.<what>`, the owner being `core` or the
 * id of the module that publishes it, and a module's own are listed as `<ID>_FACTS` beside its other lists.
 */
import type { TSchema } from '@sinclair/typebox';

/**
 * The most days a fact is held for a consumer that is not run: the outbox keeps a row no longer than it would have a person wait
 * for a module to be turned back on (D-288).
 */
export const FACT_HOLD_DAYS_MAX = 14;

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
}

export const defineFact = <Payload extends TSchema>(
  declaration: FactDeclaration<Payload>,
): FactDeclaration<Payload> => declaration;

/** The facts the core publishes. None yet: nothing in the core has a fact a module consumes. */
export const CORE_FACTS: readonly FactDeclaration[] = [];

/** Every fact type of the build: the core's and, as a module gets some, each module's `<ID>_FACTS`. */
export const FACTS: readonly FactDeclaration[] = [...CORE_FACTS];

const isHoldDays = (days: number): boolean =>
  Number.isInteger(days) && days >= 1 && days <= FACT_HOLD_DAYS_MAX;

/** What is wrong with a list of declarations: a type not named for its owner, an owner nobody is, a type declared twice, a hold for no days or for more than the outbox keeps. */
export const factOwnerProblems = (
  facts: readonly FactDeclaration[],
  moduleIds: readonly string[],
): string[] => {
  const seen = new Set<string>();
  return facts.flatMap(({ type, owner, absent }) => {
    const problems: string[] = [];
    if (seen.has(type)) problems.push(`the fact "${type}" is declared twice`);
    seen.add(type);
    if (owner !== 'core' && !moduleIds.includes(owner)) {
      problems.push(
        `the fact "${type}" is owned by "${owner}", which is neither the core nor a module of this build`,
      );
    } else if (!type.startsWith(`${owner}.`)) {
      problems.push(
        `the fact "${type}" is owned by "${owner}", so it must be named "${owner}.<what>"`,
      );
    }
    if (typeof absent === 'object' && !isHoldDays(absent.holdDays)) {
      problems.push(
        `the fact "${type}" is held ${String(absent.holdDays)} days when its consumer is off: a whole number from 1 to ${String(FACT_HOLD_DAYS_MAX)}`,
      );
    }
    return problems;
  });
};
