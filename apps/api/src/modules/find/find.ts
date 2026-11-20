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
 *
 * **Each source's hits are capped** at the limit, whatever it answers: it is asked for one more than that, and the group says
 * `more` when it had it. A source that answers a thousand costs the answer ten. The answer is `partial` when a source that could
 * have answered was `slow` or failed: what came back in time is answered, and the person may ask again.
 *
 * **Each source is measured** (`purlay_search_source_*`): how long it took to answer or to be given up on, and each time it was
 * skipped and why, by its module and its id, so an operator sees a source that keeps being skipped before a person stops using it.
 */
import type { Executor } from '@purlay/db';
import type { FindGroup, FindHit, FindResponse, SkippedSource } from '@purlay/types';
import type { Logger } from '../../platform/logging';
import type { SearchSkip, ServerMetrics } from '../../platform/metrics';
import { currentRequest, withinRequest } from '../../platform/logging';
import type { ModuleSearchSource } from '../../platform/ports/search-source';
import { withDeadline } from '../../platform/request-deadline';
import { assertMinted, entitledTo, type WorkspaceContext } from '../../platform/tenancy';

/** Past a source's own query on its index, well under what a person waits at a search box. */
const SEARCH_SOURCE_DEADLINE_MS = 1_500;

export interface FindDependencies {
  /** The application's database, whose connections a source takes from its module's share. */
  readonly database: Executor;
  readonly log: Logger;
  /** The sources of the modules this process runs. */
  readonly sources: readonly ModuleSearchSource[];
  /** The sources of modules this process does not run, by id with their module. */
  readonly off: readonly { readonly module: string; readonly source: string }[];
  /** A module's own request deadline in milliseconds, `undefined` where it declared none. */
  readonly deadlineOf: (module: string) => number | undefined;
  /** What a source is held to when its module's own deadline is longer. */
  readonly sourceDeadlineMs?: number;
  /** Where each source's time and each skip are counted. */
  readonly metrics: Pick<ServerMetrics, 'searchSourceDuration' | 'searchSourceSkipped'>;
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
          // One more than is shown, to know whether there is more without counting every match.
          async () => await source.search({ database, context, query, limit: limit + 1 }),
        ),
      () => SLOW,
    );
    if (outcome === SLOW) {
      owned.warn('a search source passed its deadline and was skipped', { deadlineMs: ms });
      return { source: source.id, reason: 'slow' };
    }
    return { source: source.id, hits: outcome.slice(0, limit), more: outcome.length > limit };
  } catch (error) {
    owned.error('a search source failed and was skipped', { err: error });
    return { source: source.id, reason: 'error' };
  }
};

const countSkip = (
  { metrics }: FindDependencies,
  series: { readonly module: string; readonly source: string },
  reason: SearchSkip,
): void => {
  metrics.searchSourceSkipped.inc({ ...series, reason });
};

/** Asks one source and counts what became of it: the time it took, and a skip with its reason. */
const askCounted = async (
  dependencies: FindDependencies,
  asked: ModuleSearchSource,
  context: WorkspaceContext,
  query: string,
  limit: number,
): Promise<FindGroup | SkippedSource> => {
  const started = performance.now();
  const answer = await askOne(dependencies, asked, context, query, limit);
  const series = { module: asked.module, source: asked.source.id };
  dependencies.metrics.searchSourceDuration.observe(series, (performance.now() - started) / 1_000);
  if ('reason' in answer) countSkip(dependencies, series, answer.reason);
  return answer;
};

/** Asks every source that runs at once; the groups keep the order of the composition, the skipped ones follow in it. */
export const findAcross = async (
  dependencies: FindDependencies,
  context: WorkspaceContext,
  query: string,
  limit: number,
): Promise<FindResponse> => {
  assertMinted(context);
  // A module the workspace is not granted is not asked, and is said to be off as one the process does not run (D-289).
  const granted = dependencies.sources.filter(({ module }) => entitledTo(context, module));
  const withheld = dependencies.sources.filter(({ module }) => !entitledTo(context, module));
  const answers = await Promise.all(
    granted.map(async (source) => await askCounted(dependencies, source, context, query, limit)),
  );
  const groups: FindGroup[] = [];
  const skipped: SkippedSource[] = [];
  for (const answer of answers) {
    if ('hits' in answer) groups.push(answer);
    else skipped.push(answer);
  }
  const off = [
    ...withheld.map(({ module, source }) => ({ module, source: source.id })),
    ...dependencies.off,
  ];
  for (const series of off) {
    countSkip(dependencies, series, 'off');
    skipped.push({ source: series.source, reason: 'off' });
  }
  return { groups, skipped, partial: skipped.some(({ reason }) => reason !== 'off') };
};
