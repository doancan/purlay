/**
 * What a module holds of a capability another module provides (`MODULES.md` §4, D-283 §3).
 *
 * A port is an interface the core defines in this folder and a module implements: types only, no I/O, so any module may import
 * it. A module that `uses` one is not told it exists: it is handed the implementation where the module that provides it is
 * run and `undefined` where it is not, and the type makes the caller say what that means. There is no `capabilities.has`
 * and no `register`; the running modules are known when the process starts and the composition is made once.
 */

/** A port of an optional partner: the implementation, or `undefined` where that partner is not run. */
export type Port<Implementation extends object> = Implementation | undefined;
