/**
 * A reference from one module's record to another module's (`MODULES.md` §4, D-291): opaque `(module, type, id)`, kept in the
 * referrer's own table beside the label the record had when it was linked, with no key to the other module's table. The referrer
 * asks `resolveRef` of its ports whether the record can be shown now; the answer for anything it cannot is one value.
 *
 * Types and one constant, as the other ports are: the provider implements `RecordResolver` under the capability
 * `<its id>.records`, and the core's `resolveRef` (`module-ports.ts`) is the only caller.
 */
import type { Executor } from '@purlay/db';

export interface ModuleRef {
  /** The id of the module that owns the record. */
  readonly module: string;
  /** The provider's own word for the kind of record (`issue`). */
  readonly type: string;
  readonly id: string;
}

/**
 * Whose workspace a question is asked in and which modules that workspace may use: what a request's `WorkspaceContext` carries and
 * a worker or a consumer is handed for the workspace it is working on. `modules` is `null` where no policy judged the grants.
 */
export interface WorkspaceScope {
  readonly workspaceId: string;
  readonly modules: ReadonlySet<string> | null;
}

/**
 * `unavailable` is the one answer for a provider that is not run, stopped, not granted to the workspace, a record that is gone,
 * of another workspace or not the asker's to see: nobody can tell one from another (D-291, D-21).
 */
export type ResolvedRef =
  | { readonly status: 'available'; readonly ref: ModuleRef; readonly label: string }
  | { readonly status: 'unavailable' };

export const UNAVAILABLE_REF: ResolvedRef = { status: 'unavailable' };

/** What a provider implements: the record's live label in the workspace, or `undefined` for a record the workspace does not have. */
export interface RecordResolver {
  readonly resolve: (input: {
    /** The asker's database, so the question is held to the asker's share of the pool. */
    readonly database: Executor;
    readonly scope: WorkspaceScope;
    readonly type: string;
    readonly id: string;
  }) => Promise<{ readonly label: string } | undefined>;
}
