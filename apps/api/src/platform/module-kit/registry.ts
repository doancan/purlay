/**
 * Which modules a process runs (`MODULES.md` §3, D-250).
 *
 * `moduleRegistry` checks the modules a build carries — once, so a wrong manifest fails the build's own
 * tests rather than an operator's boot — and `resolve` turns the operator's `MODULES` setting into the
 * ordered list to start. Both report **every** problem at once, as `loadConfig` does: fixing them one
 * restart at a time is how a first deployment becomes an afternoon.
 *
 * Pure: it reads no environment and opens nothing. The composition root passes the setting in.
 */
import type { ModuleManifest } from './manifest';

/**
 * The first path segment of every route the contract gives today. A module's id may not be one of these:
 * the web router and `/api` both read an id as a path, and a module that took `workspaces` would answer
 * to the core's address. `registry.test.ts` holds this list to `API.md`, so a route added there without
 * being added here fails a test instead of waiting for a collision.
 */
export const RESERVED_MODULE_IDS: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'assets',
  'attachments',
  'auth',
  'channels',
  'client',
  'github-app',
  'health',
  'images',
  'integrations',
  'invitations',
  'me',
  'messages',
  'metrics',
  'missed-mail',
  'native',
  'notifications',
  'push',
  'releases',
  'server',
  'setup',
  'webhooks',
  'workspaces',
  'ws',
]);

/** The setting that runs the core alone: written out, because blank is read as unset. */
const NONE = 'none';
const MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const CAPABILITY = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;

/** A setting or a bundle that cannot start. `problems` is every reason, one sentence each. */
export class ModuleConfigError extends Error {
  readonly problems: readonly string[];

  constructor(subject: string, problems: readonly string[]) {
    super(`${subject}:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ModuleConfigError';
    this.problems = problems;
  }
}

export interface ModuleRegistry {
  /** The modules this build carries, in the order they were given. */
  readonly bundled: readonly ModuleManifest[];
  /**
   * The modules to start for a `MODULES` setting, partners first. Unset or blank is every bundled module —
   * the configuration reads a blank variable as unset everywhere, and a blank that turned modules off would
   * be a surprise — and `none` is the core alone. Throws `ModuleConfigError` for an unknown or repeated id, an empty item, or a module
   * whose requirement is not enabled.
   */
  resolve(setting: string | undefined): readonly ModuleManifest[];
}

/**
 * Checks a build's modules and returns the registry over them.
 *
 * Throws `ModuleConfigError` for an id that is malformed, reserved or repeated; a requirement or partner
 * that is not a module of this build, or is the module itself; a capability two modules both provide; and
 * a cycle among `requires` and `optional`, which would leave no order to start them in. Mutual `optional`
 * partners are a cycle too: one of the two must be the one that knows the other.
 */
export const moduleRegistry = (manifests: readonly ModuleManifest[]): ModuleRegistry => {
  const problems = bundleProblems(manifests);
  if (problems.length > 0)
    throw new ModuleConfigError('the modules of this build are wrong', problems);
  const bundled = [...manifests];

  return {
    bundled,
    // A subset of a bundle with a start order has one, so nothing is left over here.
    resolve: (setting: string | undefined): readonly ModuleManifest[] =>
      startOrder(enabledBy(bundled, setting)).ordered,
  };
};

const bundleProblems = (manifests: readonly ModuleManifest[]): string[] => {
  const problems: string[] = [];
  const ids = new Set<string>();
  const providedBy = new Map<string, string>();

  for (const manifest of manifests) {
    const { id } = manifest;
    if (!MODULE_ID.test(id)) {
      problems.push(
        `"${id}" is not a module id: lowercase letters, digits and hyphens, starting with a letter`,
      );
    } else if (RESERVED_MODULE_IDS.has(id)) {
      problems.push(`"${id}" is a path the core owns and cannot be a module id`);
    }
    if (ids.has(id)) problems.push(`two modules are called "${id}"`);
    ids.add(id);

    for (const capability of manifest.provides) {
      if (!CAPABILITY.test(capability)) {
        problems.push(
          `"${id}" provides "${capability}", which is not a capability name like "chat.post-system-message"`,
        );
      }
      const earlier = providedBy.get(capability);
      if (earlier !== undefined && earlier !== id) {
        problems.push(`"${earlier}" and "${id}" both provide "${capability}"`);
      }
      providedBy.set(capability, id);
    }
  }

  for (const manifest of manifests) {
    for (const [kind, partners] of [
      ['requires', manifest.requires],
      ['optional', manifest.optional],
    ] as const) {
      for (const partner of partners) {
        if (partner === manifest.id) problems.push(`"${manifest.id}" lists itself under ${kind}`);
        else if (!ids.has(partner)) {
          problems.push(
            `"${manifest.id}" ${kind} "${partner}", which is not a module of this build`,
          );
        }
      }
    }
    const both = manifest.requires.filter((partner) => manifest.optional.includes(partner));
    for (const partner of both) {
      problems.push(`"${manifest.id}" lists "${partner}" as both required and optional`);
    }
  }

  // The order only means something when the graph is sound, so a cycle is looked for last.
  if (problems.length === 0) {
    const { stuck } = startOrder(manifests);
    if (stuck.length > 0) {
      problems.push(
        `these modules wait on one another and have no start order: ${stuck.join(', ')}`,
      );
    }
  }
  return problems;
};

const enabledBy = (
  bundled: readonly ModuleManifest[],
  setting: string | undefined,
): readonly ModuleManifest[] => {
  if (setting === undefined) return bundled;
  if (setting.trim() === '') return bundled;
  if (setting.trim() === NONE) return [];

  const problems: string[] = [];
  const named = new Set<string>();
  const known = new Map(bundled.map((manifest) => [manifest.id, manifest]));
  const items = setting.split(',').map((item) => item.trim());

  for (const item of items) {
    if (item === '') {
      problems.push('MODULES has an empty item: a doubled or trailing comma');
    } else if (named.has(item)) {
      problems.push(`MODULES names "${item}" twice`);
    } else if (!known.has(item)) {
      problems.push(
        `MODULES names "${item}", which this build does not have (it has: ${idsOf(bundled)})`,
      );
    }
    named.add(item);
  }

  const enabled = bundled.filter((manifest) => named.has(manifest.id));
  for (const manifest of enabled) {
    for (const required of manifest.requires) {
      if (!named.has(required)) {
        problems.push(`"${manifest.id}" requires "${required}", which MODULES does not enable`);
      }
    }
  }
  if (problems.length > 0)
    throw new ModuleConfigError('MODULES cannot start this process', problems);
  return enabled;
};

const idsOf = (manifests: readonly ModuleManifest[]): string =>
  manifests.length === 0 ? 'none' : manifests.map((manifest) => manifest.id).join(', ');

/**
 * Partners before the modules that use them, and the modules that wait on one another and so can never
 * start. A round starts everything whose present partners have started, by id, so the same modules always
 * start in the same order.
 */
const startOrder = (
  manifests: readonly ModuleManifest[],
): { readonly ordered: ModuleManifest[]; readonly stuck: string[] } => {
  const present = new Set(manifests.map((manifest) => manifest.id));
  const started = new Set<string>();
  const ordered: ModuleManifest[] = [];
  let remaining = [...manifests].sort((a, b) => a.id.localeCompare(b.id));

  for (;;) {
    const ready = remaining.filter((manifest) =>
      [...manifest.requires, ...manifest.optional]
        .filter((partner) => present.has(partner))
        .every((partner) => started.has(partner)),
    );
    if (ready.length === 0) break;
    for (const manifest of ready) started.add(manifest.id);
    ordered.push(...ready);
    remaining = remaining.filter((manifest) => !started.has(manifest.id));
  }
  return { ordered, stuck: remaining.map((manifest) => manifest.id) };
};
