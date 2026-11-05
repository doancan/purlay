/**
 * What a module says about itself (`MODULES.md` §2, D-250).
 *
 * Only the fields something reads today. The rest of the manifest — migrations, routes, events, search
 * sources, what the module's data needs from erasure and export — arrives in the step that reads it, so a
 * field here is never a promise nothing keeps.
 *
 * Types only: nothing in this folder opens a connection or reads the environment, so a module can import
 * it without pulling the platform in.
 */
export interface ModuleManifest {
  /** Lowercase letters, digits and hyphens: the word an operator writes in `MODULES`. */
  readonly id: string;
  /** Modules that must be enabled for this one to start. */
  readonly requires: readonly string[];
  /** Modules this one uses when they are enabled; absent, it hides the feature or does nothing. */
  readonly optional: readonly string[];
  /** Capabilities this module offers, asked for by name through the core (`MODULES.md` §4). */
  readonly provides: readonly string[];
  /**
   * The HTTP routes the module owns, as path templates: `:name` is one segment and a trailing `**` is the rest.
   * A module that is not run has no route, so a request for one is the `404` of any unknown path
   * (`MODULES.md` §3). No method: a path is a module's whole.
   */
  readonly routes?: readonly string[];
  /**
   * The operations of a client frame on the socket that the module owns. A process that does not run the module
   * answers one as it answers an operation nobody has: the socket is a way in like any route (`MODULES.md` §3).
   */
  readonly frames?: readonly string[];
  /**
   * The events the module's services send to sockets. A process that does not run the module hears none of them, from
   * its own services or from a node that does run it, and does not take on what telling them needs (who is online is
   * `PRESENCE`'s): a module that is not run tells nothing about itself (`MODULES.md` §3).
   */
  readonly events?: readonly string[];
  /**
   * The scheduled jobs (`bun run job <name>`) that act for the module's users, mail for one. A scheduler that still
   * runs one of a module that is not run is answered with success and a line saying so: there is nothing for it to
   * do. A sweep or a purge of the module's rows is not listed: rows outlive the module's being off, and keeping
   * them within their retention does not depend on it.
   */
  readonly jobs?: readonly string[];
}
