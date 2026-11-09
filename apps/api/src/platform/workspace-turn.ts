/**
 * The workspace a worker's visit or a fact's delivery is for, as the framework hands it (D-289 §10, D-283): a `WorkspaceScope` that
 * only the walk of the entitled workspaces and the delivery of a fact make. The seams that write for a workspace with no person
 * acting (a notice, a follow-up fact) refuse a scope made any other way, as the context of a request is refused unless the
 * membership guard minted it (`tenancy.ts`): a module cannot name a workspace and be believed.
 */
import type { WorkspaceScope } from './ports/record-ref';

/** Not exported: only `mintTurn`, below, adds to it. */
const minted = new WeakSet<object>();

/** For the framework's two callers, `eachEntitled` and `deliver`; a module that calls it is a mistake a review reads. */
export const mintTurn = (scope: WorkspaceScope): WorkspaceScope => {
  const turn = Object.freeze({ workspaceId: scope.workspaceId, modules: scope.modules });
  minted.add(turn);
  return turn;
};

export const assertTurn = (turn: WorkspaceScope): void => {
  if (!minted.has(turn)) {
    throw new Error(
      'a workspace scope that the framework did not hand out was refused: a loop or a consumer acts for the workspaces it is given',
    );
  }
};
