/**
 * What a module tells the build happened, as a type with a payload (`MODULES.md` §4, D-283 §3).
 *
 * A fact carries the ids of what changed and a short label, never its state: whoever consumes it reads the state itself.
 * The declarations live here and not in a module's folder because a module binds to the contract and not to another module,
 * and the payload is a wire shape (`CONTRIBUTING.md` §1.4). A type is named `<owner>.<what>`, the owner being `core` or the
 * id of the module that publishes it, and a module's own are listed as `<ID>_FACTS` in its `<id>.ts`, declared with `defineFact` from
 * `fact-declaration.ts` (a file of its own, so that `<id>.ts` and this file, which joins its list, do not import one another).
 */
import { FACT_HOLD_DAYS_MAX, FACT_SHAPE_FIRST, type FactDeclaration } from './fact-declaration';

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
  return facts.flatMap(({ type, owner, absent, shape, reads }) => {
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
    if (shape !== undefined && !(Number.isInteger(shape) && shape >= FACT_SHAPE_FIRST)) {
      problems.push(`the fact "${type}" has the shape ${String(shape)}: a whole number from 1`);
    }
    for (const earlier of Object.keys(reads ?? {}).map(Number)) {
      if (!(
        Number.isInteger(earlier) &&
        earlier >= FACT_SHAPE_FIRST &&
        earlier < (shape ?? FACT_SHAPE_FIRST)
      )) {
        problems.push(
          `the fact "${type}" reads the shape ${String(earlier)}, which is not an earlier shape than its own`,
        );
      }
    }
    return problems;
  });
};
