/**
 * What a module tells the build happened, as a type with a payload (`MODULES.md` §4, D-283 §3).
 *
 * A fact carries the ids of what changed and a short label, never its state: whoever consumes it reads the state itself.
 * The declarations live here and not in a module's folder because a module binds to the contract and not to another module,
 * and the payload is a wire shape (`CONTRIBUTING.md` §1.4). A type is named `<owner>.<what>`, the owner being `core` or the
 * id of the module that publishes it, and a module's own are listed as `<ID>_FACTS` beside its other lists.
 */
import type { TSchema } from '@sinclair/typebox';

export interface FactDeclaration<Payload extends TSchema = TSchema> {
  /** `<owner>.<what>`. */
  readonly type: string;
  /** `core` or a module id: the one party that may publish it. */
  readonly owner: string;
  /** The shape of the payload, checked where it is published and where it is delivered. */
  readonly schema: Payload;
}

export const defineFact = <Payload extends TSchema>(
  declaration: FactDeclaration<Payload>,
): FactDeclaration<Payload> => declaration;

/** The facts the core publishes. None yet: nothing in the core has a fact a module consumes. */
export const CORE_FACTS: readonly FactDeclaration[] = [];

/** Every fact type of the build: the core's and, as a module gets some, each module's `<ID>_FACTS`. */
export const FACTS: readonly FactDeclaration[] = [...CORE_FACTS];

/** What is wrong with a list of declarations: a type not named for its owner, an owner nobody is, a type declared twice. */
export const factOwnerProblems = (
  facts: readonly FactDeclaration[],
  moduleIds: readonly string[],
): string[] => {
  const seen = new Set<string>();
  return facts.flatMap(({ type, owner }) => {
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
    return problems;
  });
};
