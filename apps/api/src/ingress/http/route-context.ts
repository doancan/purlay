/**
 * What the core's route groups (`routes/`) are made from: the dependencies the handlers receive, the modules this process
 * runs, and the parts of the socket door a write publishes through. A group takes the context and what is its own alone;
 * the two bundles most groups want on top of it are made here once (`sendingOf`, `creatingOf`).
 */
import type { ModuleId } from '@purlay/types';
import type { Composition } from '../../composition';
import { readWorkspaceCreators } from '../../modules/setup/settings';
import type { WorkspaceCreators } from '../../modules/workspaces/creators';
import type { Executor } from '@purlay/db';
import type { SocketLifecycle } from '../ws/socket';
import type { LeasedDependencies } from './dependencies';

export interface RouteContext {
  readonly dependencies: LeasedDependencies;
  /** The modules this process runs (`composition.ts`). */
  readonly modules: Composition;
  /** The words an operator writes in `MODULES` for the modules this process runs. */
  readonly moduleIds: readonly ModuleId[];
  /** The deadline each module's request runs against (`platform/request-deadline.ts`). */
  readonly deadlineOf: (module: string) => number | undefined;
  readonly sockets: Pick<SocketLifecycle, 'bus' | 'atomically' | 'online'>;
}

/** Dependencies of a write that tells the sockets: through the bus, inside the transaction the write is in. */
export type Sending = LeasedDependencies & Pick<SocketLifecycle, 'bus' | 'atomically'>;

export const sendingOf = ({ dependencies, sockets }: RouteContext): Sending => ({
  ...dependencies,
  bus: sockets.bus,
  atomically: sockets.atomically,
});

/** Dependencies of what makes or lists a workspace: who may, and which modules are run, stopped and granted. */
export type Creating = LeasedDependencies & {
  readonly workspaceCreators: (executor: Executor) => Promise<WorkspaceCreators>;
  readonly modules: readonly ModuleId[];
  readonly suspended: Composition['suspension']['current'];
  readonly effectiveModules: Composition['effectiveModules'];
};

/** Who may make a workspace: the setting as it is now, each time it is asked (D-155, D-179 §6). */
export const creatingOf = ({ dependencies, modules, moduleIds }: RouteContext): Creating => ({
  ...dependencies,
  workspaceCreators: dependencies.workspaceCreators ?? readWorkspaceCreators,
  modules: moduleIds,
  suspended: modules.suspension.current,
  effectiveModules: modules.effectiveModules,
});
