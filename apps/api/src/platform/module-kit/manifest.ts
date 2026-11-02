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
}
