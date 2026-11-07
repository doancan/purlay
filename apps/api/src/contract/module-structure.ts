/**
 * Which module owns what, as the contract bundle tells a client that is not this code (D-273).
 *
 * Read from what already is the authority and from nowhere else: each manifest's `routes`, `frames`, `events` and
 * `notifications`, and the core's claims. A route, an event or an operation a module lists is its own in the bundle with
 * no list of the bundle's, and one nobody lists is the build's failure, not a field left blank.
 */
import { ClientFrame, ServerFrame, type EndpointSpec } from '@purlay/types';
import { CORE_CLAIMS } from '../platform/module-kit/core-claims';
import type { ModuleManifest } from '../platform/module-kit/manifest';
import { CORE_OWNER, NO_OWNER, ownersOf } from '../platform/module-kit/ownership';

/** One module as a client reads it: what it needs and what it owns on the wire. Every list is sorted. */
export interface ModuleJson {
  readonly id: string;
  readonly requires: readonly string[];
  readonly optional: readonly string[];
  /** Path templates (`:name` one segment, a trailing `**` the rest): what answers `404 ROUTE_NOT_FOUND` where the module is off. */
  readonly routes: readonly string[];
  /** The client operations on the socket the module owns. */
  readonly frames: readonly string[];
  /** The server events the module sends. */
  readonly events: readonly string[];
  /** The `NotificationType` values the module's notifications have. */
  readonly notificationTypes: readonly string[];
  /** The fact types the module tells the others, and the ones it takes from them (D-287): what a second implementation must handle. */
  readonly publishes: readonly string[];
  readonly consumes: readonly string[];
  /** The capabilities it asks another module for, which are `undefined` for it where that module is off. */
  readonly uses: readonly string[];
}

export interface ModuleStructure {
  readonly modules: readonly ModuleJson[];
  readonly ownerOfEndpoint: (endpoint: EndpointSpec) => string;
  /** Every server event by name, the core's or a module's. */
  readonly eventOwners: Readonly<Record<string, string>>;
  /** Every client operation by name, the core's or a module's. */
  readonly frameOwners: Readonly<Record<string, string>>;
}

const sorted = (values: readonly string[] | undefined): string[] => [...(values ?? [])].sort();

/** Each name with the one that lists it: the core (`coreNames`) or a module's `field`; a name nobody lists throws. */
const ownersOfNames = (
  names: readonly string[],
  coreNames: readonly string[],
  manifests: readonly ModuleManifest[],
  field: 'frames' | 'events',
): Record<string, string> =>
  Object.fromEntries(
    sorted(names).map((name) => {
      if (coreNames.includes(name)) return [name, CORE_OWNER];
      const owner = manifests.find((manifest) => (manifest[field] ?? []).includes(name));
      if (owner === undefined) {
        throw new Error(
          `the ${field === 'frames' ? 'operation' : 'event'} ${name} has no owner: the core and no manifest lists it`,
        );
      }
      return [name, owner.id];
    }),
  );

export const moduleStructure = (manifests: readonly ModuleManifest[]): ModuleStructure => {
  if (manifests.some((manifest) => manifest.id === CORE_OWNER)) {
    throw new Error(
      `a module may not be called "${CORE_OWNER}": it is the owner the core's own routes carry`,
    );
  }
  const owners = ownersOf(manifests, CORE_CLAIMS);
  return {
    modules: manifests
      .map((manifest): ModuleJson => ({
        id: manifest.id,
        requires: sorted(manifest.requires),
        optional: sorted(manifest.optional),
        routes: sorted(manifest.routes),
        frames: sorted(manifest.frames),
        events: sorted(manifest.events),
        notificationTypes: sorted(manifest.notifications?.map((kind) => kind.type)),
        publishes: sorted(manifest.publishes),
        consumes: sorted(manifest.consumes),
        uses: sorted(manifest.uses),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    ownerOfEndpoint: (endpoint): string => {
      const owner = owners.ofRoute(endpoint.path);
      if (owner === NO_OWNER) {
        throw new Error(
          `the endpoint ${endpoint.id} (${endpoint.path}) has no owner: the core and no manifest lists its path`,
        );
      }
      return owner;
    },
    eventOwners: ownersOfNames(
      ServerFrame.anyOf.map((frame) => frame.properties.event.const as string),
      CORE_CLAIMS.events,
      manifests,
      'events',
    ),
    frameOwners: ownersOfNames(
      ClientFrame.anyOf.map((frame) => frame.properties.op.const as string),
      CORE_CLAIMS.frames,
      manifests,
      'frames',
    ),
  };
};
