/**
 * The application as the modules it runs make it (D-250, `MODULES.md` §3).
 *
 * The core leaves places open — what a new workspace starts with, what an erased account forgets, who answers
 * for a workspace's channels, what a deleted workspace's purge takes, what an export holds, which columns
 * readiness checks — and a module fills the ones it has. This is the one place that sees both sides: it takes the
 * modules a process runs and makes the hooks, the port, the purge and the catalogues from what they contribute.
 * With no module the core stands alone: no hook runs, nobody answers for channels, the purge takes the core's
 * tables, the exports hold the core's.
 */
import { PRODUCT_MIGRATION_SETS, type MigrationSet } from '@purlay/db';
import { FACTS, isModuleId, type FactDeclaration, type ModuleId } from '@purlay/types';
import { chatModule } from './features/chat/module';
import { requireOwnUpload, type AttachmentReader } from './modules/attachments/readable';
import { AppError, attachmentNotFound } from './platform/errors';
import { issuesModule } from './features/issues/module';
import type { JobWork } from './modules/jobs/jobs';
import {
  workerDeadlinesOf,
  workerProblem,
  type ModuleWorker,
  type RunningWorker,
} from './modules/workers/module-workers';
import { assembleCatalogue, type ExportContribution } from './modules/export/catalogue';
import { coreExport } from './modules/export/core-export';
import { corePersonalExport } from './modules/export/core-personal-export';
import {
  assemblePersonalCatalogue,
  type PersonalContribution,
} from './modules/export/personal-catalogue';
import { noPushNotices, type NoticeWords, type PushNotices } from './modules/push/notices';
import type { UserErased } from './modules/users/erasure';
import { noWorkspaceChannels, type WorkspaceChannels } from './modules/workspaces/channels-port';
import type { WorkspacePurge } from './modules/workspaces/deletion-purge';
import type { WorkspaceCreated } from './modules/workspaces/workspaces';
import type { KindOwners } from './modules/inbox/sink';
import type { FactConsumers } from './platform/fact-consumers';
import { outboxConsumerWorkers } from './modules/workers/outbox-consumer';
import type { ModuleSearchSource, SearchSource } from './platform/ports/search-source';
import type { FrameHandlers } from './platform/frame-handlers';
import type { RouterFrameContext } from './realtime/router';
import { hookList } from './platform/hooks';
import { CORE_CLAIMS } from './platform/module-kit/core-claims';
import { moduleRegistry } from './platform/module-kit/registry';
import { auditAccess, type AuditAccess } from './platform/module-kit/audit-access';
import {
  CORE_PERMISSIONS,
  permissionTable,
  type PermissionTable,
} from './platform/module-kit/permissions';
import { CORE_OWNER, ownersOf, type Owners } from './platform/module-kit/ownership';
import { ownsPath } from './platform/module-kit/routes';
import type { AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from './ingress/http/module-routes';
import type { ModuleManifest, NotificationKindDeclaration } from './platform/module-kit/manifest';
import type { CollatedColumn } from './platform/readiness';
import {
  effectiveModules,
  type EntitlementMode,
  type EntitlementPolicy,
  type EntitlementRow,
} from './platform/module-kit/entitlement';

/**
 * What a module may contribute: each slot is the core's, and a module fills the ones it has.
 *
 * What it contributes to the lifecycle of its data — an erased account's, a deleted workspace's, an export, who answers
 * for the channels a member leaves, the columns readiness checks — applies even to a process that does not run it, and
 * so does every bundled module's, always: a person's right to be erased does not wait for a setting, and a flag that
 * could say otherwise has no safe value (D-250 rule 5). Only what *acts* (`workspaceCreated`, `readAttachment`,
 * `pushNotices`, the routes) waits for the module to run. A table that may not exist — a module's own migration set
 * not applied — is each hook's to ask about with `tableExists`, at the moment it needs the table (`MODULES.md` §5).
 */
export interface BundledModule {
  readonly manifest: ModuleManifest;
  /**
   * Who may read a file, where the module holds files attached to what it owns. Asked only while the module runs: a
   * process without it answers for the core's own unsent uploads and for nothing else. Every running module's reader is
   * asked in turn and a file is readable if any says so; a reader says no by throwing `attachmentNotFound`.
   */
  readonly readAttachment?: AttachmentReader;
  /** What a write told, for the push sender: asked only while the module runs. */
  readonly pushNotices?: PushNotices;
  /** What a push says of each kind of notice the manifest declares `pushed`, in the person's language (D-286 §9). */
  readonly noticeWords?: NoticeWords;
  /** Run inside the transaction of a new workspace, once its owner is a member. */
  readonly workspaceCreated?: (...args: Parameters<WorkspaceCreated['run']>) => Promise<void>;
  /** Run inside the transaction of an erased account. */
  readonly userErased?: (...args: Parameters<UserErased['run']>) => Promise<void>;
  /** Answers for the channels of a workspace; at most one module does. */
  readonly workspaceChannels?: WorkspaceChannels;
  readonly workspacePurge?: WorkspacePurge;
  readonly export?: ExportContribution;
  readonly personalExport?: PersonalContribution;
  readonly collatedColumns?: readonly CollatedColumn[];
  /**
   * The work of each job the manifest names under `jobs` or `retention`, and of no other: `bun run job` runs them by name,
   * so a job in the manifest with no work, or work the manifest does not name, stops the build (`compose`). What is under
   * `retention` runs in every process, and what is under `jobs` only where the module runs (`closedJob`).
   */
  readonly jobWork?: Readonly<Record<string, JobWork>>;
  /**
   * The background loops the module runs inside the API process, each a name, an interval and the work (`MODULES.md` §9): started
   * only where the module runs, and each iteration held to the module's share of the pool and its `workerDeadline`.
   */
  readonly workers?: readonly ModuleWorker[];
  /**
   * What serves each client operation the manifest names under `frames`, and no other: the router dispatches an operation to
   * the module that owns it and asks nobody else. An operation named with no handler, or a handler for one not named, stops
   * the build (`compose`), as the work of a job does (D-276).
   */
  readonly frameHandlers?: FrameHandlers<RouterFrameContext>;
  /**
   * The module's HTTP routes, as an Elysia plugin made from what they are handed, at the paths its manifest lists under
   * `routes` and no others (D-280). The application uses the plugin of every bundled module, whether or not it runs, and a
   * module that is not run is closed by its manifest as before (D-255 §2). A module that has routes in its manifest
   * and supplies none fails `route-ownership.test.ts`.
   */
  readonly routes?: (dependencies: ModuleRouteDependencies) => AnyElysia;
  /**
   * What handles each fact type the manifest names under `consumes`, and no other: a type consumed with no handler, or a handler
   * for one not consumed, stops the build (`compose`), as for the work of a job (D-283 §3).
   */
  readonly factConsumers?: FactConsumers;
  /**
   * What implements each capability the manifest lists under `provides`, and no other, by the capability's name: a port the core
   * defines in `platform/ports/` (D-283 §3). Handed to the modules that `use` it only while this module runs.
   */
  readonly ports?: Readonly<Record<string, object>>;
  /**
   * What answers the workspace-wide find for each source the manifest lists under `searchSources`, and no other: the core's `find`
   * asks each of the modules that run, as the module, under a deadline (D-285). A source listed with nothing behind it, or one
   * supplied that is not listed, stops the build (`compose`).
   */
  readonly searchSources?: readonly SearchSource[];
}

/**
 * One reader out of several: a file is readable if any of them says so, and a reader's refusal is its
 * `attachmentNotFound`. Any other failure is a failure, not a no.
 */
const anyReader =
  (readers: readonly AttachmentReader[]): AttachmentReader =>
  async (executor, userId, attachmentId) => {
    for (const read of readers) {
      try {
        return await read(executor, userId, attachmentId);
      } catch (error) {
        const refusal = error instanceof AppError && error.body.code === 'ATTACHMENT_NOT_FOUND';
        if (!refusal) throw error;
      }
    }
    throw attachmentNotFound();
  };

/** What is wrong with the jobs a module names and the work it supplies for them, or `undefined` when they are the same names. */
const jobWorkProblem = ({ manifest, jobWork = {} }: BundledModule): string | undefined => {
  const named = [...(manifest.jobs ?? []), ...(manifest.retention ?? [])];
  const withoutWork = named.filter((job) => !(job in jobWork));
  const unnamed = Object.keys(jobWork).filter((job) => !named.includes(job));
  if (withoutWork.length > 0) {
    return `"${manifest.id}" names the jobs ${withoutWork.join(', ')} in its manifest and supplies no work for them`;
  }
  if (unnamed.length > 0) {
    return `"${manifest.id}" supplies work for ${unnamed.join(', ')}, which its manifest does not name under jobs or retention`;
  }
  return undefined;
};

/** What is wrong with the frame handlers a module supplies and the operations its manifest names, or `undefined` when they are the same. */
const frameHandlerProblem = ({
  manifest,
  frameHandlers = {},
}: BundledModule): string | undefined => {
  const named = manifest.frames ?? [];
  const unserved = named.filter((op) => !(op in frameHandlers));
  const unnamed = Object.keys(frameHandlers).filter((op) => !named.includes(op));
  if (unserved.length > 0) {
    return `"${manifest.id}" names the frames ${unserved.join(', ')} in its manifest and supplies no handler for them`;
  }
  return unnamed.length === 0
    ? undefined
    : `"${manifest.id}" supplies handlers for ${unnamed.join(', ')}, which its manifest does not name under frames`;
};

/** What is wrong with the fact handlers a module supplies and the types its manifest consumes, or `undefined` when they are the same. */
const factConsumerProblem = ({
  manifest,
  factConsumers = {},
}: BundledModule): string | undefined => {
  const named = manifest.consumes ?? [];
  const unhandled = named.filter((type) => !(type in factConsumers));
  const undeclared = Object.keys(factConsumers).filter((type) => !named.includes(type));
  if (unhandled.length > 0) {
    return `"${manifest.id}" consumes the facts ${unhandled.join(', ')} in its manifest and supplies no handler for them`;
  }
  if (undeclared.length > 0) {
    return `"${manifest.id}" supplies handlers for ${undeclared.join(', ')}, which its manifest does not name under consumes`;
  }
  return undefined;
};

/**
 * The workers a module runs: the ones it declares and, when it consumes facts, the one that delivers them (D-288 §8). Every
 * carried module's, run or not, is what the failure counter has a series for.
 */
export const workersOf = (
  module: BundledModule,
  facts: readonly FactDeclaration[] = FACTS,
  effective?: EntitlementPolicy['effective'],
): readonly ModuleWorker[] => [
  ...(module.workers ?? []),
  ...outboxConsumerWorkers(module.manifest.id, module.factConsumers, facts, effective),
];

/** What is wrong with the ports a module supplies and the capabilities its manifest provides, or `undefined` when they are the same. */
const portProblem = ({ manifest, ports = {} }: BundledModule): string | undefined => {
  const unimplemented = manifest.provides.filter((capability) => !(capability in ports));
  const unlisted = Object.keys(ports).filter(
    (capability) => !manifest.provides.includes(capability),
  );
  if (unimplemented.length > 0) {
    return `"${manifest.id}" provides ${unimplemented.join(', ')} in its manifest and supplies no implementation for it`;
  }
  if (unlisted.length > 0) {
    return `"${manifest.id}" supplies implementations for ${unlisted.join(', ')}, which its manifest does not list under provides`;
  }
  return undefined;
};

/** What is wrong with the search sources a module supplies and the ids its manifest lists, or `undefined` when they are the same. */
const searchSourceProblem = ({
  manifest,
  searchSources = [],
}: BundledModule): string | undefined => {
  const named = manifest.searchSources ?? [];
  const supplied = searchSources.map((source) => source.id);
  const unanswered = named.filter((id) => !supplied.includes(id));
  const notListed = supplied.filter((id) => !named.includes(id));
  if (unanswered.length > 0) {
    return `"${manifest.id}" lists the search sources ${unanswered.join(', ')} in its manifest and supplies nothing behind them`;
  }
  if (notListed.length > 0) {
    return `"${manifest.id}" supplies the search sources ${notListed.join(', ')}, which its manifest does not list under searchSources`;
  }
  return undefined;
};

/**
 * What is wrong with a module a workspace is granted that runs work of its own, or `undefined`. A scheduled job or a background
 * loop acts for workspaces without a request to carry the guard (`tenancy.ts`), so until their work is given the workspace's grant
 * a grant would go on being served to a workspace that lost it (D-289): the module is `always`, or has neither.
 */
const unguardedWorkProblem = ({ manifest, workers = [] }: BundledModule): string | undefined =>
  manifest.entitlement === 'always' || ((manifest.jobs ?? []).length === 0 && workers.length === 0)
    ? undefined
    : `"${manifest.id}" is a grant of the workspace and declares jobs or workers, whose work is not given the workspace's grant: it must say entitlement: 'always'`;

/** Every module this build carries. A new one is added here and nowhere else in the core's wiring. */
export const bundledModules = [
  chatModule,
  issuesModule,
] as const satisfies readonly BundledModule[];

/** The modules of this build, checked: a malformed id, a repeat or a missing partner stops the build's own tests. */
export const registry = moduleRegistry(
  bundledModules.map((module) => module.manifest),
  CORE_CLAIMS,
);

export interface Composition {
  readonly modules: readonly BundledModule[];
  /** Every module this build carries, run or not: what a route table needs to apply each one's declared budget. */
  readonly bundled: readonly BundledModule[];
  /**
   * The work of every job a carried module names, by name. Retention jobs are the module's whether it runs or not, and a
   * job of a module that does not run is asked of `closedJob` first.
   */
  readonly jobWork: Readonly<Record<string, JobWork>>;
  /** The workers of the modules this process runs, and of no module that is off: what `startWorkers` starts. */
  readonly workers: readonly RunningWorker[];
  /** The reader of `/api/attachments/:attachmentId`: the core's, widened by the modules that run. */
  readonly readAttachment: AttachmentReader;
  /** What the push sender is told by: the module's, or nothing where none runs. */
  readonly pushNotices: PushNotices;
  /** The module whose notices that is, for the push failure counter's label; the core where none runs. */
  readonly pushOwner: string;
  readonly workspaceCreated: WorkspaceCreated;
  readonly userErased: UserErased;
  readonly workspaceChannels: WorkspaceChannels;
  readonly workspacePurge: WorkspacePurge;
  readonly exportCatalogue: ReturnType<typeof assembleCatalogue>;
  readonly personalExportCatalogue: ReturnType<typeof assemblePersonalCatalogue>;
  readonly collatedColumns: readonly CollatedColumn[];
  /** What a role may do: the core's permissions and those of the modules this process runs, and nothing of a module that is not run. */
  readonly permissions: PermissionTable;
  /** Who reads which audit actions: the permissions above over the actions of every module the build carries. */
  readonly auditAccess: AuditAccess;
  /** The kinds of notification the modules this process runs send: a module that is off offers none. */
  readonly notificationKinds: readonly NotificationKindDeclaration[];
  /** Which running module declares each kind of notification: whose notice a kind written to the inbox is (D-286). */
  readonly noticeOwners: KindOwners;
  /** The kinds the modules this process runs declare `pushed`: what the inbox's sink tells devices of. */
  readonly pushedKinds: ReadonlySet<string>;
  /** What a push says of a kind of notice: the words of the module that declares it, and none for a module that is off. */
  readonly noticeWords: NoticeWords;
  /** The ids of the search sources of the modules this process runs: a module that is off is not queried. */
  readonly searchSources: readonly string[];
  /** The sources `find` asks, each with the module it is asked as: the modules this process runs, and none that is off. */
  readonly findSources: readonly ModuleSearchSource[];
  /** The ids of the sources of the modules the build carries and this process does not run, which `find` answers as `off` and never asks. */
  readonly findSourcesOff: readonly string[];
  /** The implementation of each capability the modules this process runs provide; one whose module is off is not a key, so a read of it is `undefined`. */
  readonly ports: Readonly<Record<string, object>>;
  /** What a workspace with no grant of its own is given (D-289): the server's `WORKSPACE_MODULES`. */
  readonly entitlementMode: EntitlementMode;
  /** The modules a workspace may use, from the grants read for it: the modules this process runs less those it is not granted (D-289). */
  readonly effectiveModules: (rows: readonly EntitlementRow[], now: Date) => ReadonlySet<string>;
  /** The migration sets of the modules this process runs, applied after the core's (D-250, D-86). */
  readonly migrationSets: readonly MigrationSet[];
  /** Which module each route and job belongs to, over every module the build carries: the label of the metrics and logs. */
  readonly owner: Owners;
  /** Whether a path is one a module this build carries owns and this process does not run: the `404` of an unknown route. */
  readonly closed: (path: string) => boolean;
  /** Whether a job belongs to a module this build carries and this process does not run. */
  readonly closedJob: (name: string) => boolean;
  /** The handlers of the operations of the modules this process runs: a module that is not run serves none. */
  readonly frameHandlers: FrameHandlers<RouterFrameContext>;
  /** Whether a client frame's operation belongs to a module this build carries and this process does not run. */
  readonly closedFrame: (op: string) => boolean;
  /** Whether a server event belongs to a module this build carries and this process does not run. */
  readonly closedEvent: (event: string) => boolean;
}

/**
 * The composition of the modules given, in the order given. `bundled` is every module the build carries, so that a path
 * of one that is not run is known to be closed: with chat left out, its routes are not routes. Both lists are taken as
 * ordered: `composeFor` is how a build gets them in the order the registry resolved (`MODULES.md` §3), and the order is
 * what hook registration, the purge and the export tables follow.
 */
export const compose = (
  modules: readonly BundledModule[],
  bundled: readonly BundledModule[] = bundledModules,
  entitlementMode: EntitlementMode = 'open',
  facts: readonly FactDeclaration[] = FACTS,
): Composition => {
  const workspaceCreated = hookList<Parameters<WorkspaceCreated['run']>>();
  const userErased = hookList<Parameters<UserErased['run']>>();
  // What a process acts with is the modules it runs; what it keeps whole is every module the build carries, in the same
  // order whichever of them run (a module given that the build does not carry follows the build's).
  const holding = [...bundled, ...modules.filter((module) => !bundled.includes(module))];
  for (const module of modules) {
    if (module.workspaceCreated !== undefined) workspaceCreated.register(module.workspaceCreated);
  }
  for (const module of holding) {
    if (module.userErased !== undefined) userErased.register(module.userErased);
  }
  const answering = holding.filter((module) => module.workspaceChannels !== undefined);
  if (answering.length > 1) {
    throw new Error(
      `more than one module answers for a workspace's channels: ${answering.map((module) => module.manifest.id).join(', ')}`,
    );
  }
  for (const module of holding) {
    const problem =
      jobWorkProblem(module) ??
      frameHandlerProblem(module) ??
      factConsumerProblem(module) ??
      portProblem(module) ??
      searchSourceProblem(module) ??
      unguardedWorkProblem(module) ??
      workerProblem(module.manifest.id, workersOf(module, facts));
    if (problem !== undefined) throw new Error(problem);
  }
  const permissions = permissionTable([
    ...CORE_PERMISSIONS,
    ...modules.flatMap((module) => module.manifest.permissions ?? []),
  ]);
  const effectiveOfThisProcess: EntitlementPolicy['effective'] = (rows, now) =>
    effectiveModules({
      running: modules.map((module) => module.manifest),
      rows,
      mode: entitlementMode,
      now,
    });
  const deadlineOf = workerDeadlinesOf(holding.map((module) => module.manifest));
  const noticing = modules.find((module) => module.pushNotices !== undefined);
  return {
    modules,
    bundled,
    permissions,
    auditAccess: auditAccess(
      permissions,
      holding.flatMap((module) => module.manifest.auditActions ?? []),
    ),
    notificationKinds: modules.flatMap((module) => module.manifest.notifications ?? []),
    noticeOwners: new Map(
      modules.flatMap((module) =>
        (module.manifest.notifications ?? []).map((kind): [string, string] => [
          kind.type,
          module.manifest.id,
        ]),
      ),
    ),
    pushedKinds: new Set(
      modules.flatMap((module) =>
        (module.manifest.notifications ?? [])
          .filter((kind) => kind.pushed)
          .map((kind) => kind.type),
      ),
    ),
    noticeWords: (kind, locale, actor): ReturnType<NoticeWords> => {
      for (const module of modules) {
        const saying = module.noticeWords?.(kind, locale, actor);
        if (saying !== undefined) return saying;
      }
      return undefined;
    },
    searchSources: modules.flatMap((module) => module.manifest.searchSources ?? []),
    findSources: modules.flatMap((module) =>
      (module.searchSources ?? []).map((source) => ({ module: module.manifest.id, source })),
    ),
    findSourcesOff: bundled
      .filter((module) => !modules.includes(module))
      .flatMap((module) => module.manifest.searchSources ?? []),
    ports: Object.fromEntries(modules.flatMap((module) => Object.entries(module.ports ?? {}))),
    jobWork: Object.fromEntries(holding.flatMap((module) => Object.entries(module.jobWork ?? {}))),
    workers: modules.flatMap((module) =>
      workersOf(module, facts, effectiveOfThisProcess).map((worker) => ({
        ...worker,
        module: module.manifest.id,
        deadlineMs: deadlineOf(module.manifest.id),
      })),
    ),
    readAttachment: anyReader([
      ...modules.flatMap((module) => module.readAttachment ?? []),
      requireOwnUpload,
    ]),
    pushNotices: noticing?.pushNotices ?? noPushNotices,
    pushOwner: noticing?.manifest.id ?? CORE_OWNER,
    workspaceCreated,
    userErased,
    workspaceChannels: answering[0]?.workspaceChannels ?? noWorkspaceChannels,
    workspacePurge: {
      before: holding.flatMap((module) => module.workspacePurge?.before ?? []),
      after: holding.flatMap((module) => module.workspacePurge?.after ?? []),
      tables: holding.flatMap((module) => module.workspacePurge?.tables ?? []),
    },
    exportCatalogue: assembleCatalogue(
      coreExport,
      holding.flatMap((module) => module.export ?? []),
    ),
    personalExportCatalogue: assemblePersonalCatalogue(
      corePersonalExport,
      holding.flatMap((module) => module.personalExport ?? []),
    ),
    collatedColumns: holding.flatMap((module) => module.collatedColumns ?? []),
    entitlementMode,
    effectiveModules: effectiveOfThisProcess,
    migrationSets: PRODUCT_MIGRATION_SETS.filter((set) =>
      modules.some((module) => module.manifest.id === set.id),
    ),
    owner: ownersOf(
      bundled.map((module) => module.manifest),
      CORE_CLAIMS,
    ),
    closed: ownsPath(
      bundled
        .filter((module) => !modules.includes(module))
        .flatMap((module) => module.manifest.routes ?? []),
    ),
    closedJob: (name) =>
      bundled.some(
        (module) => !modules.includes(module) && (module.manifest.jobs ?? []).includes(name),
      ),
    frameHandlers: modules.reduce<FrameHandlers<RouterFrameContext>>(
      (handlers, module) => ({ ...handlers, ...module.frameHandlers }),
      {},
    ),
    closedFrame: (op) =>
      bundled.some(
        (module) => !modules.includes(module) && (module.manifest.frames ?? []).includes(op),
      ),
    closedEvent: (event) =>
      bundled.some(
        (module) => !modules.includes(module) && (module.manifest.events ?? []).includes(event),
      ),
  };
};

/**
 * The composition for an operator's `MODULES` setting over the modules a build carries: unset is every one, `none` the
 * core alone. What acts is the running modules in the order the registry resolved, partners first; what is held is every
 * carried module in the resolved order of the whole build, so the order does not depend on the setting. Throws
 * `ModuleConfigError` naming every problem, for the process to stop on before it listens.
 */
export const composeFor = (
  carried: readonly BundledModule[],
  setting: string | undefined,
  entitlementMode: EntitlementMode = 'open',
): Composition => {
  const carriedRegistry = moduleRegistry(
    carried.map((module) => module.manifest),
    CORE_CLAIMS,
  );
  const inResolvedOrder = (manifests: readonly ModuleManifest[]): BundledModule[] =>
    manifests.flatMap((manifest) => carried.filter((module) => module.manifest === manifest));
  return compose(
    inResolvedOrder(carriedRegistry.resolve(setting)),
    inResolvedOrder(carriedRegistry.resolve(undefined)),
    entitlementMode,
  );
};

export const compositionFor = (
  setting: string | undefined,
  entitlementMode: EntitlementMode = 'open',
): Composition => composeFor(bundledModules, setting, entitlementMode);

/** What a process runs when nothing says otherwise: every module this build carries. */
export const composition: Composition = compositionFor(undefined);

/**
 * What the boot says about modules: the ones this process runs and the ones the build carries but it does not,
 * by id, so a log line answers "does this node run chat?" without reading its environment.
 */
export const moduleReport = (
  running: Composition,
  bundled: readonly BundledModule[] = bundledModules,
): { readonly running: readonly string[]; readonly notRun: readonly string[] } => ({
  running: running.modules.map((module) => module.manifest.id),
  notRun: bundled
    .filter((module) => !running.modules.includes(module))
    .map((module) => module.manifest.id),
});

/**
 * The words an operator writes in `MODULES` for the modules this process runs, as `GET /api/me` tells them (D-273). One the
 * contract's `ModuleId` lacks stops the build here, where a client would otherwise be told an id it cannot decode.
 */
export const runningModuleIds = (running: Composition): ModuleId[] =>
  running.modules.map(({ manifest }) => {
    if (!isModuleId(manifest.id)) {
      throw new Error(`the module ${manifest.id} is not a ModuleId of @purlay/types`);
    }
    return manifest.id;
  });
