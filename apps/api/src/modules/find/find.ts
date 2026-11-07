/**
 * The workspace-wide find (D-283 §4, D-285): the words asked of each search source of each module that runs, at once, and
 * answered as a group for each source.
 *
 * **Each source is asked as its own module**: inside that module's share of the pool, so a module whose search is slow holds
 * its own connections and no other's, and under the abort signal of its deadline, which cancels what the source asked of the
 * database when the deadline passes. The deadline is `SEARCH_SOURCE_DEADLINE_MS`, or the module's own when that is shorter
 * (`deadline` of its manifest, D-270). A source past it is `slow` and the others' groups are answered without waiting; one that
 * throws is `error`, written to the log with its module and never to the caller; the source of a module this process does not run
 * is `off` and is not asked at all. What is asked of a source is the caller's `WorkspaceContext` and the words: the source
 * narrows by both in its own query.
 */
import type { Executor } from '@purlay/db';
import type { FindGroup, FindHit, FindResponse, SkippedSource } from '@purlay/types';
import type { Logger } from '../../platform/logging';
import { currentRequest, withinRequest } from '../../platform/logging';
import type { ModuleSearchSource } from '../../platform/ports/search-source';
import { withDeadline } from '../../platform/request-deadline';
import type { WorkspaceContext } from '../../platform/tenancy';

/** Past a source's own query on its index, well under what a person waits at a search box. */
const SEARCH_SOURCE_DEADLINE_MS = 1_500;

export interface FindDependencies {
  /** The application's database, whose connections a source takes from its module's share. */
  readonly database: Executor;
  readonly log: Logger;
  /** The sources of the modules this process runs. */
  readonly sources: readonly ModuleSearchSource[];
  /** The ids of the sources of modules this process does not run. */
  readonly off: readonly string[];
  /** A module's own request deadline in milliseconds, `undefined` where it declared none. */
  readonly deadlineOf: (module: string) => number | undefined;
  /** What a source is held to when its module's own deadline is longer. */
  readonly sourceDeadlineMs?: number;
}

const SLOW = Symbol('slow');

const askOne = async (
  { database, log, deadlineOf, sourceDeadlineMs = SEARCH_SOURCE_DEADLINE_MS }: FindDependencies,
  { module, source }: ModuleSearchSource,
  context: WorkspaceContext,
  query: string,
  limit: number,
): Promise<FindGroup | SkippedSource> => {
  const request = currentRequest();
  const ms = Math.min(sourceDeadlineMs, deadlineOf(module) ?? sourceDeadlineMs);
  const owned = log.child({ module, source: source.id });
  try {
    const outcome = await withDeadline<readonly FindHit[] | typeof SLOW>(
      ms,
      async (signal) =>
        await withinRequest(
          {
            requestId: request?.requestId ?? `find:${source.id}`,
            startedAt: performance.now(),
            ...(request?.sessionId === undefined ? {} : { sessionId: request.sessionId }),
            module,
            signal,
            ...(request?.entitlements === undefined ? {} : { entitlements: request.entitlements }),
          },
          async () => await source.search({ database, context, query, limit }),
        ),
      () => SLOW,
    );
    if (outcome === SLOW) {
      owned.warn('a search source passed its deadline and was skipped', { deadlineMs: ms });
      return { source: source.id, reason: 'slow' };
    }
    return { source: source.id, hits: outcome.slice(0, limit) };
  } catch (error) {
    owned.error('a search source failed and was skipped', { err: error });
    return { source: source.id, reason: 'error' };
  }
};

/** Asks every source that runs at once; the groups keep the order of the composition, the skipped ones follow in it. */
export const findAcross = async (
  dependencies: FindDependencies,
  context: WorkspaceContext,
  query: string,
  limit: number,
): Promise<FindResponse> => {
  const answers = await Promise.all(
    dependencies.sources.map(
      async (source) => await askOne(dependencies, source, context, query, limit),
    ),
  );
  const groups: FindGroup[] = [];
  const skipped: SkippedSource[] = [];
  for (const answer of answers) {
    if ('hits' in answer) groups.push(answer);
    else skipped.push(answer);
  }
  for (const source of dependencies.off) skipped.push({ source, reason: 'off' });
  return { groups, skipped };
};
