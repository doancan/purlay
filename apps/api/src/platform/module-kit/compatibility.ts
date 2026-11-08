import { FACT_SHAPE_FIRST, type FactDeclaration } from '@purlay/types';
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
  readonly frames: readonly string[];
  /** Absent from a snapshot written before facts existed (D-288): such a release promised none. */
  readonly publishes?: readonly string[];
  readonly consumes?: readonly string[];
}

/** A deliberate break, said where a reviewer reads it. `change` is the sentence `incompatibilities` gives. */
interface CompatibilityException {
  readonly change: string;
  /** YYYY-MM-DD */
  readonly on: string;
  readonly reason: string;
}

/** What a release promised of one fact: the shape it writes and the earlier shapes it still reads (D-288 §5). */
export interface ReleasedFact {
  readonly type: string;
  readonly shape: number;
  readonly reads: readonly number[];
}

/** The file the release script writes (`released-manifests.json`): the manifests as the last release shipped them. */
export interface ReleasedSnapshot {
  readonly manifests: readonly ReleasedManifest[];
  /** Absent from a snapshot written before facts had readers: such a release promised none. Sorted by type. */
  readonly facts?: readonly ReleasedFact[];
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
  frames: sorted(manifest.frames),
  publishes: sorted(manifest.publishes),
  consumes: sorted(manifest.consumes),
});

export const releasedFactFrom = (fact: FactDeclaration): ReleasedFact => ({
  type: fact.type,
  shape: fact.shape ?? FACT_SHAPE_FIRST,
  reads: Object.keys(fact.reads ?? {})
    .map(Number)
    .sort((a, b) => a - b),
});

const missing = (released: readonly string[], current: readonly string[]): string[] =>
  released.filter((name) => !current.includes(name));

/**
 * Each way the current manifests break what the last release promised, as a sentence. Not breaks: a new module, a
 * new capability, route, job, socket operation or fact, a dropped requirement or question, a new or dropped optional partner. What is silent is the
 * rest — an operator who ran the last release's set would find a module refusing to start for a partner it never
 * needed, a capability another module asks for gone, or a route, a socket operation or a scheduled job that now answers as if it never
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
      ...missing(before.frames, after.frames).map(
        (op) => `module '${before.id}' no longer owns the socket operation '${op}'`,
      ),
      ...missing(before.publishes ?? [], after.publishes ?? []).map(
        (type) => `module '${before.id}' no longer publishes the fact '${type}'`,
      ),
      ...missing(before.consumes ?? [], after.consumes ?? []).map(
        (type) => `module '${before.id}' no longer consumes the fact '${type}'`,
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

/**
 * Each shape of a fact that the last release could have written and this build cannot read, as a sentence: a rolling deploy leaves
 * this build's nodes rows of those shapes, and a row no reader describes is dead (D-288 §5). A new current shape therefore keeps the
 * reader of the one before it, and a reader is dropped only by an exception. A fact the build no longer declares is not said
 * here: the manifests' `publishes` and `consumes` hold that.
 */
export const factIncompatibilities = (
  released: readonly ReleasedFact[],
  current: readonly FactDeclaration[],
): string[] => {
  const now = new Map(current.map((fact) => [fact.type, releasedFactFrom(fact)]));
  return released.flatMap((before) => {
    const after = now.get(before.type);
    if (after === undefined) return [];
    return [before.shape, ...before.reads]
      .filter((shape) => shape !== after.shape && !after.reads.includes(shape))
      .map((shape) => `the fact '${before.type}' no longer reads the shape ${String(shape)}`);
  });
};
