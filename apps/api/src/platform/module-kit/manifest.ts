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
import type { UserRole } from '@purlay/types';

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

/**
 * A thing a role may do that a module owns, by name: `<module id>.<what>`, held by the role named and every role above it
 * (`member` below `admin` below `owner`). A process that does not run the module has no such permission: nobody holds it,
 * the owner included (`permissions.ts`).
 */
export interface PermissionDeclaration {
  readonly name: string;
  /** The lowest role that holds it. */
  readonly minimumRole: UserRole;
}

/**
 * Audit actions the module records (D-26), and the permission that reads them from the trail: the core's `audit.read`, or
 * a permission the module declares. An action the module writes and does not list fails `audit-emissions.test.ts`.
 */
export interface AuditActionGroup {
  readonly read: string;
  readonly actions: readonly string[];
}

/** What a kind of notification the module sends does (`NotificationKind` in `@purlay/types`, which a module's list is made of). */
export interface NotificationKindDeclaration {
  readonly type: string;
  readonly needsYou: boolean;
  readonly pushed: boolean;
  readonly mailed: boolean;
}

/**
 * How long one of the module's requests or frames may run before it is stopped and the database is told to cancel what it
 * was asked (`MODULES.md` §7, D-270): a number of milliseconds, or `none` with the reason, which a test lists. A module
 * that says nothing has the platform's default.
 */
type ModuleDeadlineDeclaration = { readonly ms: number } | { readonly none: string };

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
   * Whether a workspace is granted the module by the operator (`grant`, what a module left out says) or has it whenever the
   * process runs it (`always`): a workspace's grant is the commercial gate of a package, not a permission (D-289).
   */
  readonly entitlement?: 'always' | 'grant';
  /** The module's share of the database pool, or `none` with the reason it has no need of one. */
  readonly budget: ModuleBudgetDeclaration;
  /** How long a request or frame of the module may take; left out, `DEFAULT_DEADLINE_MS` (`platform/request-deadline.ts`). */
  readonly deadline?: ModuleDeadlineDeclaration;
  /**
   * How long one run of one of the module's scheduled jobs (`jobs` and `retention`) may take before it is cancelled and
   * recorded as a failed run (`MODULES.md` §7, D-274): a number of milliseconds, or `none` with the reason, which a test
   * lists. Left out, `DEFAULT_JOB_DEADLINE_MS` (`modules/jobs/module-shares.ts`).
   */
  readonly jobDeadline?: ModuleDeadlineDeclaration;
  /**
   * How long one iteration of one of the module's workers (the background loops it declares on its slot) may take before it
   * is cancelled and counted as a failure (`MODULES.md` §7, §9): a number of milliseconds, or `none` with the reason, which
   * a test lists. Left out, `DEFAULT_WORKER_DEADLINE_MS` (`modules/workers/module-workers.ts`).
   */
  readonly workerDeadline?: ModuleDeadlineDeclaration;
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
  /** What a role may do in the module that is not just "be a member", as names the services ask (`permissions.ts`). */
  readonly permissions?: readonly PermissionDeclaration[];
  /** The actions the module writes to the audit trail, with who may read them (`audit-access.ts`). */
  readonly auditActions?: readonly AuditActionGroup[];
  /** The kinds of notification the module sends, by `type`; a process that does not run it offers none of them. */
  readonly notifications?: readonly NotificationKindDeclaration[];
  /** The sources the module adds to a workspace search, by id; a process that does not run it queries none of them. */
  readonly searchSources?: readonly string[];
  /**
   * The fact types the module owns and may publish, each named `<id>.<what>` and declared in `@purlay/types` (`MODULES.md` §4,
   * D-283 §3). One module owns a type: the registry refuses two, and the core's.
   */
  readonly publishes?: readonly string[];
  /**
   * The fact types the module handles, its own, another module's or the core's. Each needs a publisher in the build and a handler
   * in the module's slot (`factConsumers`), and the build is refused for a type without either.
   */
  readonly consumes?: readonly string[];
  /**
   * The capabilities the module asks of another, by the names that module lists under `provides`. The provider must be a
   * partner the module `requires` or lists as `optional`: asking never makes a requirement, and where the provider is not run the
   * module is handed `undefined` and hides the feature or does nothing (D-283 §3).
   */
  readonly uses?: readonly string[];
}
