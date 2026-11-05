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
import {
  MODULE_ID,
  ModulesSettingError,
  parseModulesSetting,
  unmetRequirements,
  type ModulesSetting,
} from '@purlay/db';
import type { CoreClaims } from './core-claims';
import type { ModuleManifest } from './manifest';
import { templatesOverlap } from './routes';

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

const MODULES_SUBJECT = 'MODULES cannot start this process';
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
 * partners are a cycle too: one of the two must be the one that knows the other. And for what `core` claims, given by the
 * build (`CORE_CLAIMS`): a route, job, socket operation or server event that two modules both list, or that a module lists
 * and the core already has — routes by `ownsPath`'s rules, a template overlapping another when some path matches both.
 */
export const moduleRegistry = (
  manifests: readonly ModuleManifest[],
  core: Partial<CoreClaims> = {},
): ModuleRegistry => {
  const problems = bundleProblems(manifests, core);
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

/** The pools a share is tried against: one of one, the smallest that has a second, and what a deployment may configure. */
const POOLS_TRIED = [1, 2, 3, 10, 30, 100] as const;

/**
 * What a manifest's `budget` must be: said at all (a JavaScript caller or a snapshot can leave it out where the type
 * cannot), `none` with a reason, or a share that gives the module a connection and leaves the others one in every pool
 * a deployment may have (a pool of one has none to leave, and is the one case the second bound gives way).
 */
const budgetProblems = (manifest: ModuleManifest): string[] => {
  const { id, budget } = manifest;
  // The type forbids it; a manifest that is data, or written without the compiler's help, may not.
  const declared = budget as ModuleManifest['budget'] | undefined;
  if (declared === undefined) {
    return [
      `"${id}" does not say what it may take of the database: give it a \`budget\`, a share of the pool or \`none\` with the reason`,
    ];
  }
  if ('none' in declared) {
    return declared.none.trim() === ''
      ? [`"${id}" declares \`budget: none\` without a reason`]
      : [];
  }
  for (const pool of POOLS_TRIED) {
    const { maxConcurrent } = declared.poolShare(pool);
    if (
      Number.isInteger(maxConcurrent) &&
      maxConcurrent >= 1 &&
      maxConcurrent <= Math.max(1, pool - 1)
    )
      continue;
    return [
      `"${id}" has a share of ${String(maxConcurrent)} connections in a pool of ${String(pool)}: it needs at least one, and the others one too (a pool of one has none to leave)`,
    ];
  }
  return [];
};

const PERMISSION_WORD = /^[a-z][a-z0-9-]*$/;

/** A permission is named `<id>.<what>` so that two modules and the core can never choose the same one, and is declared once. */
const permissionProblems = (manifest: ModuleManifest): string[] => {
  const { id } = manifest;
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const { name } of manifest.permissions ?? []) {
    const word = name.startsWith(`${id}.`) ? name.slice(id.length + 1) : undefined;
    if (word === undefined || !PERMISSION_WORD.test(word)) {
      problems.push(`"${id}" declares the permission "${name}", which is not named "${id}.<what>"`);
    }
    if (seen.has(name)) problems.push(`"${id}" declares the permission "${name}" twice`);
    seen.add(name);
  }
  return problems;
};

const bundleProblems = (
  manifests: readonly ModuleManifest[],
  core: Partial<CoreClaims>,
): string[] => {
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

    problems.push(...budgetProblems(manifest), ...permissionProblems(manifest));

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

  problems.push(...overlapProblems(manifests, core));

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

/** The words for each kind of claim, in the order they are reported. */
const CLAIM_KINDS = [
  ['routes', 'route'],
  ['jobs', 'job'],
  ['frames', 'socket operation'],
  ['events', 'server event'],
  ['permissions', 'permission'],
] as const;

/** Two claims of one kind clash: the same name, or for a route a template with a path in common. */
const clash = (kind: keyof CoreClaims, first: string, second: string): boolean =>
  kind === 'routes' ? templatesOverlap(first, second) : first === second;

/** A module's retention jobs are jobs it owns: the name of one is what `bun run job` is asked for, as of any other. */
const claimsOf = (manifest: ModuleManifest, kind: keyof CoreClaims): readonly string[] => {
  switch (kind) {
    case 'jobs':
      return [...(manifest.jobs ?? []), ...(manifest.retention ?? [])];
    case 'permissions':
      return (manifest.permissions ?? []).map((declared) => declared.name);
    case 'routes':
    case 'frames':
    case 'events':
      return manifest[kind] ?? [];
  }
};

/** What two modules both claim, and what a module claims that the core already has. */
const overlapProblems = (
  manifests: readonly ModuleManifest[],
  core: Partial<CoreClaims>,
): string[] => {
  const problems: string[] = [];
  for (const [kind, noun] of CLAIM_KINDS) {
    manifests.forEach((manifest, index) => {
      for (const claim of claimsOf(manifest, kind)) {
        for (const theirs of core[kind] ?? []) {
          if (!clash(kind, claim, theirs)) continue;
          problems.push(
            kind === 'routes'
              ? `"${manifest.id}" owns the ${noun} "${claim}", which overlaps the core's "${theirs}"`
              : `"${manifest.id}" owns the ${noun} "${claim}", which is the core's`,
          );
        }
        for (const other of manifests.slice(index + 1)) {
          for (const theirs of claimsOf(other, kind)) {
            if (!clash(kind, claim, theirs)) continue;
            problems.push(
              kind === 'routes'
                ? `"${manifest.id}" and "${other.id}" both own routes that overlap: "${claim}" and "${theirs}"`
                : `"${manifest.id}" and "${other.id}" both own the ${noun} "${claim}"`,
            );
          }
        }
      }
    });
  }
  return problems;
};

const enabledBy = (
  bundled: readonly ModuleManifest[],
  setting: string | undefined,
): readonly ModuleManifest[] => {
  // The shape of the setting is `parseModulesSetting`'s, the reading `db:migrate` takes too; what a module
  // requires of another is `unmetRequirements`, over these manifests, the one `db:migrate` asks too.
  let parsed: ModulesSetting;
  try {
    parsed = parseModulesSetting(
      setting,
      bundled.map((manifest) => manifest.id),
    );
  } catch (error) {
    if (error instanceof ModulesSettingError) {
      throw new ModuleConfigError(MODULES_SUBJECT, error.problems);
    }
    throw error;
  }
  if (parsed.kind === 'all') return bundled;
  if (parsed.kind === 'none') return [];

  const named = new Set(parsed.ids);
  const enabled = bundled.filter((manifest) => named.has(manifest.id));
  const problems = unmetRequirements(
    parsed.ids,
    Object.fromEntries(bundled.map((manifest) => [manifest.id, manifest.requires])),
  );
  if (problems.length > 0) throw new ModuleConfigError(MODULES_SUBJECT, problems);
  return enabled;
};

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
