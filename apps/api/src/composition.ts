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
import { moduleRegistry } from './platform/module-kit/registry';
import { ownsPath } from './platform/module-kit/routes';
import type { ModuleManifest } from './platform/module-kit/manifest';
import type { CollatedColumn } from './platform/readiness';

/** What a module may contribute: each slot is the core's, and a module fills the ones it has. */
export interface BundledModule {
  readonly manifest: ModuleManifest;
  /**
   * Its tables were made by the core's own migrations, so they exist whether or not the module runs. What the module
   * contributes to the lifecycle of that data — an erased account's, a deleted workspace's, an export, who answers
   * for the channels a member leaves — then applies even to a process that does not run it: a person's right to be
   * erased does not wait for a setting. A module whose migration set makes some of its tables (chat's link between
   * a message and its files, its drafts, reminders and hidden messages) has those tables only where the set was
   * applied: the hooks ask `tableExists` before they name one, so a database migrated without the set is no failure
   * and one that has it is still kept whole (`MODULES.md` §5).
   */
  readonly dataInCore?: boolean;
  /**
   * Who may read a file, where the module holds files attached to what it owns. Asked only while the module runs: a
   * process without it answers for the core's own unsent uploads and for nothing else.
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
}

/** Every module this build carries. A new one is added here and nowhere else in the core's wiring. */
export const bundledModules: readonly BundledModule[] = [chatModule];

/** The modules of this build, checked: a malformed id, a repeat or a missing partner stops the build's own tests. */
export const registry = moduleRegistry(bundledModules.map((module) => module.manifest));

export interface Composition {
  readonly modules: readonly BundledModule[];
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
  /** The migration sets of the modules this process runs, applied after the core's (D-250, D-86). */
  readonly migrationSets: readonly MigrationSet[];
  /** Whether a path is one a module this build carries owns and this process does not run: the `404` of an unknown route. */
  readonly closed: (path: string) => boolean;
  /** Whether a job belongs to a module this build carries and this process does not run. */
  readonly closedJob: (name: string) => boolean;
  /** Whether a client frame's operation belongs to a module this build carries and this process does not run. */
  readonly closedFrame: (op: string) => boolean;
}

/**
 * The composition of the modules given. `bundled` is every module the build carries, so that a path of one that is
 * not run is known to be closed: with chat left out, its routes are not routes.
 */
export const compose = (
  modules: readonly BundledModule[],
  bundled: readonly BundledModule[] = bundledModules,
): Composition => {
  const workspaceCreated = hookList<Parameters<WorkspaceCreated['run']>>();
  const userErased = hookList<Parameters<UserErased['run']>>();
  // What a process acts with is the modules it runs; what it keeps whole is every module whose rows exist.
  const holding = [
    ...modules,
    ...bundled.filter((module) => !modules.includes(module) && module.dataInCore),
  ];
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
  return {
    modules,
    readAttachment:
      modules.find((module) => module.readAttachment !== undefined)?.readAttachment ??
      requireOwnUpload,
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
  };
};

/** What a process runs when nothing says otherwise: every module this build carries. */
export const composition: Composition = compose(bundledModules);

/**
 * The composition for an operator's `MODULES` setting: unset is every module the build carries, `none` the core
 * alone. Throws `ModuleConfigError` naming every problem, for the process to stop on before it listens.
 */
export const compositionFor = (setting: string | undefined): Composition => {
  const named = new Set(registry.resolve(setting).map((module) => module.id));
  return compose(bundledModules.filter((module) => named.has(module.manifest.id)));
};
