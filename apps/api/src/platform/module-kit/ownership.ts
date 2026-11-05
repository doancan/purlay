/**
 * Which module a route, a job or a socket operation belongs to, for the label `module` on `/metrics` and in the logs (D-250 rule 7).
 *
 * Read from what is already the authority: the core's claims and each manifest's `routes`, `jobs` and `retention`, so a route or a job
 * added to either is labelled with no list of its own. The answer is one of a short closed set — `core`, a module id the
 * code spells, or `none` — never anything a caller sent, so it adds series only as modules are added.
 */
import type { CoreClaims } from './core-claims';
import type { ModuleManifest } from './manifest';
import { ownsPath } from './routes';

/** What the core answers for. */
export const CORE_OWNER = 'core';
/** What no route or job claims: the client's catch-all, a request turned away at the edge, a path nothing serves. */
export const NO_OWNER = 'none';

export interface Owners {
  /** The owner of a route as the router registered it (`/api/channels/:channelId`), not of a path as asked for. */
  readonly ofRoute: (route: string) => string;
  readonly ofJob: (job: string) => string;
  /** The owner of a client frame's operation (`SUBSCRIBE`, `PING`); `none` for a word that is no operation. */
  readonly ofFrame: (op: string) => string;
}

export const ownersOf = (manifests: readonly ModuleManifest[], core: CoreClaims): Owners => {
  const byRoute = manifests.map((manifest) => ({
    id: manifest.id,
    owns: ownsPath(manifest.routes ?? []),
  }));
  return {
    ofRoute: (route) =>
      core.routes.includes(route)
        ? CORE_OWNER
        : (byRoute.find((module) => module.owns(route))?.id ?? NO_OWNER),
    ofFrame: (op) =>
      core.frames.includes(op)
        ? CORE_OWNER
        : (manifests.find((manifest) => (manifest.frames ?? []).includes(op))?.id ?? NO_OWNER),
    ofJob: (job) =>
      core.jobs.includes(job)
        ? CORE_OWNER
        : (manifests.find(
            (manifest) =>
              (manifest.jobs ?? []).includes(job) || (manifest.retention ?? []).includes(job),
          )?.id ?? NO_OWNER),
  };
};
