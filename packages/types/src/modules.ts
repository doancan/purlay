/**
 * The modules a build of this server carries, by the words an operator writes in `MODULES` (D-250, D-273).
 *
 * The registry owns the list (`apps/api/src/composition.ts`); `@purlay/types` cannot import it, so the list is
 * spelled here once for the wire and held to the registry by a test (`contract/bundle.test.ts`), and the contract
 * bundle fails to build when the two differ (`moduleIdProblems`). A client that is older than the server meets ids it
 * does not have: it ignores them, as it ignores any member of a union it does not know (D-190, `API.md` §1).
 */
import { Type, type Static } from '@sinclair/typebox';

export const ModuleId = Type.Union([Type.Literal('chat'), Type.Literal('issues')]);
export type ModuleId = Static<typeof ModuleId>;

/** The same ids as a list, in the order the schema names them. */
export const MODULE_IDS: readonly ModuleId[] = ModuleId.anyOf.map((member) => member.const);

export const isModuleId = (value: string): value is ModuleId =>
  MODULE_IDS.some((id) => id === value);
