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
import { chatModule } from './features/chat/module';
import { requireOwnUpload, type AttachmentReader } from './modules/attachments/readable';
import { AppError, attachmentNotFound } from './platform/errors';
import { issuesModule } from './features/issues/module';
import type { JobWork } from './modules/jobs/jobs';
import { assembleCatalogue, type ExportContribution } from './modules/export/catalogue';
import { coreExport } from './modules/export/core-export';
import { corePersonalExport } from './modules/export/core-personal-export';
import {
  assemblePersonalCatalogue,
  type PersonalContribution,
} from './modules/export/personal-catalogue';
import { noPushNotices, type PushNotices } from './modules/push/notices';
import type { UserErased } from './modules/users/erasure';
import { noWorkspaceChannels, type WorkspaceChannels } from './modules/workspaces/channels-port';
import type { WorkspacePurge } from './modules/workspaces/deletion-purge';
import type { WorkspaceCreated } from './modules/workspaces/workspaces';
import { hookList } from './platform/hooks';
import { CORE_CLAIMS } from './platform/module-kit/core-claims';
import { moduleRegistry } from './platform/module-kit/registry';
import {
  CORE_PERMISSIONS,
  permissionTable,
  type PermissionTable,
} from './platform/module-kit/permissions';
import { ownersOf, type Owners } from './platform/module-kit/ownership';
import { ownsPath } from './platform/module-kit/routes';
import type { ModuleManifest } from './platform/module-kit/manifest';
import type { CollatedColumn } from './platform/readiness';

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
  /** The reader of `/api/attachments/:attachmentId`: the core's, widened by the modules that run. */
  readonly readAttachment: AttachmentReader;
  /** What the push sender is told by: the module's, or nothing where none runs. */
  readonly pushNotices: PushNotices;
  readonly workspaceCreated: WorkspaceCreated;
  readonly userErased: UserErased;
  readonly workspaceChannels: WorkspaceChannels;
  readonly workspacePurge: WorkspacePurge;
  readonly exportCatalogue: ReturnType<typeof assembleCatalogue>;
  readonly personalExportCatalogue: ReturnType<typeof assemblePersonalCatalogue>;
  readonly collatedColumns: readonly CollatedColumn[];
  /** What a role may do: the core's permissions and those of the modules this process runs, and nothing of a module that is not run. */
  readonly permissions: PermissionTable;
  /** The migration sets of the modules this process runs, applied after the core's (D-250, D-86). */
  readonly migrationSets: readonly MigrationSet[];
  /** Which module each route and job belongs to, over every module the build carries: the label of the metrics and logs. */
  readonly owner: Owners;
  /** Whether a path is one a module this build carries owns and this process does not run: the `404` of an unknown route. */
  readonly closed: (path: string) => boolean;
  /** Whether a job belongs to a module this build carries and this process does not run. */
  readonly closedJob: (name: string) => boolean;
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
    const problem = jobWorkProblem(module);
    if (problem !== undefined) throw new Error(problem);
  }
  return {
    modules,
    bundled,
    permissions: permissionTable([
      ...CORE_PERMISSIONS,
      ...modules.flatMap((module) => module.manifest.permissions ?? []),
    ]),
    jobWork: Object.fromEntries(holding.flatMap((module) => Object.entries(module.jobWork ?? {}))),
    readAttachment: anyReader([
      ...modules.flatMap((module) => module.readAttachment ?? []),
      requireOwnUpload,
    ]),
    pushNotices:
      modules.find((module) => module.pushNotices !== undefined)?.pushNotices ?? noPushNotices,
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
  );
};

export const compositionFor = (setting: string | undefined): Composition =>
  composeFor(bundledModules, setting);

/** What a process runs when nothing says otherwise: every module this build carries. */
export const composition: Composition = compositionFor(undefined);

/**
 * Starts what belongs to a module, in a process that runs it and in no other: the boot's own work for a module (the
 * timers of chat's scheduled messages and reminders) must not run where the module is off, whose tables may not be there.
 */
export const startWhereRunning = (running: Composition, id: string, start: () => void): void => {
  if (running.modules.some((module) => module.manifest.id === id)) start();
};

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
