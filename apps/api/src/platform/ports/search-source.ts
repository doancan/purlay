/**
 * What a module offers the workspace-wide find (`MODULES.md` §4, D-283 §4, D-285): a source, which answers the words with what
 * the caller may read of the module's own data. Types only, as the other ports are: the core defines it in this folder, a module
 * implements it in its slot's `searchSources` under the id its manifest lists, and the core's `find` asks each source of a module
 * that runs, at once, as that module (its share of the pool, its abort signal) and against a deadline.
 *
 * A source narrows by the caller and the workspace in its own query, never by filtering what it read: what it may not show must
 * not reach its answer even for a moment (D-34). It answers newest first, at most `limit`.
 */
import type { Executor } from '@purlay/db';
import type { FindHit } from '@purlay/types';
import type { WorkspaceContext } from '../tenancy';

interface SearchSourceInput {
  /** Already the module's own: every connection it takes is asked of the module's share, and cancelled with the deadline. */
  readonly database: Executor;
  readonly context: WorkspaceContext;
  /** The words as the person typed them, trimmed, of at least `SEARCH_QUERY_MIN` characters. */
  readonly query: string;
  readonly limit: number;
}

export interface SearchSource {
  /** The id the module's manifest lists under `searchSources`: the name of the group in the answer. */
  readonly id: string;
  readonly search: (input: SearchSourceInput) => Promise<readonly FindHit[]>;
}

/** A source with the module whose share, deadline and name it runs under: what the composition hands `find`. */
export interface ModuleSearchSource {
  readonly module: string;
  readonly source: SearchSource;
}
