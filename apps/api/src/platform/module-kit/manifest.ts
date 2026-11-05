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
/** What one module may take of the shared database (`platform/module-budget.ts` holds it to this). */
export interface BudgetLimits {
  /** Transactions the module may have open at once; at least one, and below the pool's size. */
  readonly maxConcurrent: number;
  /** How long a request waits for a slot before it is refused. */
  readonly queueTimeoutMs: number;
  /** The longest any statement of the module may run; PostgreSQL ends it with `57014`. */
  readonly statementTimeoutMs: number;
}

/**
 * What a module says of its share of the connection pool (`MODULES.md` §7, D-250 rule 7). Never left out: a module either
 * is held to a share, worked out from the pool's size, or says it is not and why. The core applies it to every module's
 * routes the same way, so a module that is added cannot be forgotten.
 */
type ModuleBudgetDeclaration =
  { readonly poolShare: (poolMax: number) => BudgetLimits } | { readonly none: string };

export interface ModuleManifest {
  /** Lowercase letters, digits and hyphens: the word an operator writes in `MODULES`. */
  readonly id: string;
  /** Modules that must be enabled for this one to start. */
  readonly requires: readonly string[];
  /** Modules this one uses when they are enabled; absent, it hides the feature or does nothing. */
  readonly optional: readonly string[];
  /** Capabilities this module offers, asked for by name through the core (`MODULES.md` §4). */
  readonly provides: readonly string[];
  /** The module's share of the database pool, or `none` with the reason it has no need of one. */
  readonly budget: ModuleBudgetDeclaration;
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
   * do. A sweep or a purge of the module's rows is not listed here but under `retention`.
   */
  readonly jobs?: readonly string[];
  /**
   * The scheduled jobs (`bun run job <name>`) that keep the module's rows within their retention: a purge of history past
   * its days, a sweep of a cache. Rows outlive the module's being off, so these run in every process, whichever modules it
   * runs, and the core's job runner takes them from here as it takes `jobs` (`composition.ts`). The names are the
   * module's alone, as `jobs` are, and the module supplies the work for each.
   */
  readonly retention?: readonly string[];
}
