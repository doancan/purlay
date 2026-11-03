import type { ModuleManifest } from './manifest';

/**
 * What a release promised of one module: the parts of its manifest that something outside the module relies on
 * (`MODULES.md` §2). Sorted, so a snapshot written twice is the same bytes.
 */
export interface ReleasedManifest {
  readonly id: string;
  readonly requires: readonly string[];
  readonly optional: readonly string[];
  readonly provides: readonly string[];
  readonly routes: readonly string[];
  readonly jobs: readonly string[];
}

/** A deliberate break, said where a reviewer reads it. `change` is the sentence `incompatibilities` gives. */
export interface CompatibilityException {
  readonly change: string;
  /** YYYY-MM-DD */
  readonly on: string;
  readonly reason: string;
}

/** The file the release script writes (`released-manifests.json`): the manifests as the last release shipped them. */
export interface ReleasedSnapshot {
  readonly manifests: readonly ReleasedManifest[];
  /** Cleared by the release script: an exception holds for the release being worked towards, not for ever. */
  readonly exceptions: readonly CompatibilityException[];
}

const sorted = (names: readonly string[] | undefined): string[] => [...(names ?? [])].sort();

export const releasedFrom = (manifest: ModuleManifest): ReleasedManifest => ({
  id: manifest.id,
  requires: sorted(manifest.requires),
  optional: sorted(manifest.optional),
  provides: sorted(manifest.provides),
  routes: sorted(manifest.routes),
  jobs: sorted(manifest.jobs),
});

const missing = (released: readonly string[], current: readonly string[]): string[] =>
  released.filter((name) => !current.includes(name));

/**
 * Each way the current manifests break what the last release promised, as a sentence. Not breaks: a new module, a
 * new capability, route or job, a dropped requirement, a new or dropped optional partner. What is silent is the
 * rest — an operator who ran the last release's set would find a module refusing to start for a partner it never
 * needed, a capability another module asks for gone, or a route or a scheduled job that now answers as if it never
 * existed.
 */
export const incompatibilities = (
  released: readonly ReleasedManifest[],
  current: readonly ModuleManifest[],
): string[] => {
  const now = new Map(current.map((manifest) => [manifest.id, releasedFrom(manifest)]));
  return released.flatMap((before) => {
    const after = now.get(before.id);
    if (after === undefined) {
      return [
        `module '${before.id}' is no longer in the build, or its id changed: operators name it in MODULES`,
      ];
    }
    return [
      ...missing(after.requires, before.requires).map(
        (name) =>
          `module '${before.id}' now requires '${name}', which the last release did not ${before.optional.includes(name) ? '(it was optional)' : 'ask of it'}`,
      ),
      ...missing(before.provides, after.provides).map(
        (name) => `module '${before.id}' no longer provides '${name}'`,
      ),
      ...missing(before.routes, after.routes).map(
        (route) => `module '${before.id}' no longer owns the route '${route}'`,
      ),
      ...missing(before.jobs, after.jobs).map(
        (job) => `module '${before.id}' no longer runs the job '${job}'`,
      ),
    ];
  });
};

/**
 * What is left to say once the snapshot's exceptions are applied: the breaks nobody excused, and the exceptions that
 * excuse nothing (so one does not outlive the break it was for).
 */
export const unexcused = (changes: readonly string[], snapshot: ReleasedSnapshot): string[] => [
  ...changes
    .filter((change) => !snapshot.exceptions.some((exception) => exception.change === change))
    .map(
      (change) =>
        `${change}. Undo it, or say it is deliberate: add {change, on, reason} to "exceptions" in released-manifests.json`,
    ),
  ...snapshot.exceptions
    .filter((exception) => !changes.includes(exception.change))
    .map((exception) => `the exception "${exception.change}" excuses nothing now: remove it`),
];
