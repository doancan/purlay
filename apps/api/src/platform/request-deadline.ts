/**
 * How long a module's request or frame may take (`MODULES.md` §7, D-269).
 *
 * A request that runs past its deadline is answered `504 REQUEST_TIMEOUT` with the error envelope, whatever it is waiting
 * for, and its `signal` aborts: what it had asked of the database is cancelled (`@purlay/db`'s lease) and what it asks
 * next is refused, so the work stops with the answer instead of running on unseen. The core's own routes have none:
 * uploads, downloads and exports are bounded as they are, and nothing a module serves streams or waits long.
 */
import { AppError } from './errors';
import type { ModuleManifest } from './module-kit/manifest';

/** Past the pool's wait (3 s) and any statement a module may run (5 s for issues), and under the pool's own 30 s. */
export const DEFAULT_DEADLINE_MS = 20_000;

/** The deadline of each module of a build in milliseconds, `undefined` for one that declared `none`. */
export const deadlinesOf = (
  manifests: readonly Pick<ModuleManifest, 'id' | 'deadline'>[],
): ((moduleId: string) => number | undefined) => {
  const byModule = new Map(
    manifests.map(({ id, deadline }) => [
      id,
      deadline === undefined ? DEFAULT_DEADLINE_MS : 'ms' in deadline ? deadline.ms : undefined,
    ]),
  );
  return (moduleId) => byModule.get(moduleId);
};

/** What a request that overran is told: the server stopped waiting, and what it asked may have been done. */
export const timedOut = (): AppError =>
  new AppError({
    code: 'REQUEST_TIMEOUT',
    message:
      'The request took too long and was stopped. Check what it asked for before repeating it.',
  });

/**
 * Runs `run` against a deadline. When it passes, the signal aborts and `expired` is the answer, though `run` may still be
 * going: it is not waited for, and what it asks of the database from then on is refused. A rejection of `run` after that
 * is its own to have been cancelled, and is not reported twice.
 */
export const withDeadline = async <T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
  expired: () => T,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const overran = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(timedOut());
      resolve(expired());
    }, ms);
  });
  try {
    return await Promise.race([run(controller.signal), overran]);
  } finally {
    clearTimeout(timer);
  }
};
