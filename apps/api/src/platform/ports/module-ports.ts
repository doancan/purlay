/**
 * The ports a module is handed (`MODULES.md` §4, D-283 §3): those of the capabilities its manifest `uses`, as they stand for one
 * workspace. A port of a provider that is not run, that the administrator stopped (D-296) or that the workspace is not granted
 * (D-289) is `undefined`, so the type makes the caller say what that means, and the question is asked again for each workspace.
 * The composition makes one view for each module (`Composition.portsFor`) and hands it to the module's routes, workers and fact
 * consumers, each bound to the database of its own request or iteration.
 */
import type { Executor } from '@purlay/db';
import {
  UNAVAILABLE_REF,
  type ModuleRef,
  type RecordResolver,
  type ResolvedRef,
  type WorkspaceScope,
} from './record-ref';

/**
 * The capabilities a module may provide and the type of the port behind each. A record resolver is `<module id>.records` for any
 * module, so a new module that can be linked to adds nothing here; a new kind of port is a member, which a reviewer reads.
 */
export type CapabilityPorts = Readonly<Record<`${string}.records`, RecordResolver>>;

export interface ModulePorts {
  /** The ports of the capabilities the module `uses` whose provider this workspace may use now; the others are absent. */
  readonly of: (scope: WorkspaceScope) => Readonly<Partial<CapabilityPorts>>;
  /**
   * Whether another module's record can be shown in the workspace, and under which label. It never throws for a provider that is
   * absent, stopped or not granted, for a capability the module does not `use`, or for a record that is not there: all are
   * `unavailable`. A failure of the database is not one of those and is thrown.
   */
  readonly resolveRef: (ref: ModuleRef, scope: WorkspaceScope) => Promise<ResolvedRef>;
}

/** The module's side of the question: what it `uses`, who provides each, and the implementations that run now. */
export interface PortSources {
  readonly uses: readonly string[];
  readonly providerOf: (capability: string) => string | undefined;
  readonly running: () => Readonly<Record<string, object>>;
}

/** Makes a module's view bound to a database; the composition gives one to whoever starts work for a module. */
export type PortsFor = (module: string, database: Executor) => ModulePorts;

/** The ports of a module that uses none: the view of a test of one module's pieces. */
export const noPorts: ModulePorts = {
  of: () => ({}),
  resolveRef: () => Promise.resolve(UNAVAILABLE_REF),
};

const isRecordResolver = (port: object): port is RecordResolver =>
  'resolve' in port && typeof port.resolve === 'function';

export const modulePorts = (sources: PortSources, database: Executor): ModulePorts => {
  const reachable = (scope: WorkspaceScope): Record<string, object> => {
    const running = sources.running();
    const reached: Record<string, object> = {};
    for (const capability of sources.uses) {
      const provider = sources.providerOf(capability);
      const port = running[capability];
      if (provider === undefined || port === undefined) continue;
      if (scope.modules !== null && !scope.modules.has(provider)) continue;
      reached[capability] = port;
    }
    return reached;
  };
  return {
    // The map above holds only keys of `uses`, each the port its provider supplied under that capability.
    of: (scope) => reachable(scope) as Partial<CapabilityPorts>,
    resolveRef: async (ref, scope): Promise<ResolvedRef> => {
      const port = reachable(scope)[`${ref.module}.records`];
      if (port === undefined || !isRecordResolver(port)) return UNAVAILABLE_REF;
      const found = await port.resolve({ database, scope, type: ref.type, id: ref.id });
      return found === undefined
        ? UNAVAILABLE_REF
        : { status: 'available', ref, label: found.label };
    },
  };
};
