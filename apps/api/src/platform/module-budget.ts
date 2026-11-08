/**
 * What one module may take from the shared database (`MODULES.md` §7, D-266).
 *
 * The share is a cap on the requests a module has holding a connection, with a queue timeout and a `statement_timeout`;
 * a request over it waits briefly and is then told the database is busy (`503 DATABASE_UNAVAILABLE`), which a client
 * retries. It is held **at the connection**: `createApp` leases the one database it hands every handler
 * (`leasingExecutor`), and the lease is the share of the module the request or frame is noted as (`noteModule`). So a
 * read is held as a write is, and no handler asks. The core takes its connections as the pool gives them (`inTheCore`),
 * and the modules together may take the pool less what the core keeps (`coreReserve`), so signing in and reading a
 * session are never queued behind a busy module. A request holds one slot however many connections it takes, so one
 * that reads again inside its transaction cannot wait for itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConnectionLease, LeaseConnection } from '@purlay/db';
import { AppError } from './errors';
import { currentRequest, type RequestScope } from './logging';
import type { BudgetLimits, ModuleManifest } from './module-kit/manifest';

export type ModuleBudget = BudgetLimits;

export interface Slots {
  /**
   * True with a slot, false when none came free within `timeoutMs`. A freed slot goes to the lowest `rank` waiting, and to
   * the one that waited longest among equals: ranked by when a request began, it is the oldest request's turn.
   */
  acquire(timeoutMs: number, rank?: number): Promise<boolean>;
  release(): void;
  inUse(): number;
}

/** In rank order, first in first out among equals, with a limit on the wait. A slot given up is handed to the next in line at once. */
export const slots = (limit: number): Slots => {
  let inUse = 0;
  const waiting: { readonly rank: number; readonly turn: (granted: boolean) => void }[] = [];
  return {
    inUse: (): number => inUse,
    acquire: (timeoutMs: number, rank = 0): Promise<boolean> => {
      if (inUse < limit) {
        inUse += 1;
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        const turn = (granted: boolean): void => {
          clearTimeout(timer);
          resolve(granted);
        };
        const timer = setTimeout(() => {
          const at = waiting.findIndex((entry) => entry.turn === turn);
          if (at !== -1) waiting.splice(at, 1);
          resolve(false);
        }, timeoutMs);
        const after = waiting.findIndex((entry) => entry.rank > rank);
        waiting.splice(after === -1 ? waiting.length : after, 0, { rank, turn });
      });
    },
    release: (): void => {
      const next = waiting.shift();
      // The slot passes to the one waiting; it is not freed and taken again.
      if (next === undefined) inUse -= 1;
      else next.turn(true);
    },
  };
};

const outside = new AsyncLocalStorage<true>();

/**
 * Makes `work` the core's, whichever module's request calls it: its connections are not held by a share. For the guards
 * that decide whether a request may be made at all (membership), so a person with no part in a module holds none of its slots.
 */
export const inTheCore =
  <Args extends readonly unknown[], Result>(work: (...args: Args) => Promise<Result>) =>
  async (...args: Args): Promise<Result> =>
    await outside.run(true, async () => await work(...args));

/**
 * The connections the core keeps for itself: a fifth of the pool, at least one, and none in a pool of one (which has
 * nothing to leave). What the modules share between them is the rest.
 */
export const coreReserve = (poolMax: number): number =>
  poolMax <= 1 ? 0 : Math.max(1, Math.floor(poolMax / CORE_RESERVE_DIVISOR));

export const CORE_RESERVE_DIVISOR = 5;

interface Share {
  readonly module: string;
  readonly limits: ModuleBudget;
  readonly slots: Slots;
}

/** What one request holds: how many of its connections are open, and whether the slots came. */
interface Hold {
  count: number;
  readonly granted: Promise<boolean>;
}

/**
 * The lease of each module of a build, made once from what the manifests declare (`budget`): the share a module
 * says, applied to the requests and frames noted as its own (`noteModule`). Nothing here names a module, so a module
 * that is added is held to what it says by owning routes. A module that declared `none` has no share to hold it.
 */
export const moduleConnections = (
  manifests: readonly Pick<ModuleManifest, 'id' | 'budget'>[],
  poolMax: number,
): LeaseConnection => {
  const shares = new Map<string, Share>();
  for (const { id, budget } of manifests) {
    if (!('poolShare' in budget)) continue;
    const limits = budget.poolShare(poolMax);
    shares.set(id, { module: id, limits, slots: slots(limits.maxConcurrent) });
  }
  // Together the modules may have what the pool is, less what the core keeps.
  const together = slots(Math.max(1, poolMax - coreReserve(poolMax)));
  const holds = new WeakMap<RequestScope, Hold>();

  const take = async (share: Share, rank: number): Promise<boolean> => {
    const started = performance.now();
    if (!(await share.slots.acquire(share.limits.queueTimeoutMs, rank))) return false;
    const left = Math.max(0, share.limits.queueTimeoutMs - (performance.now() - started));
    if (await together.acquire(left, rank)) return true;
    share.slots.release();
    return false;
  };

  const drop = (request: RequestScope, hold: Hold, share: Share, granted: boolean): void => {
    hold.count -= 1;
    if (hold.count > 0) return;
    holds.delete(request);
    if (!granted) return;
    together.release();
    share.slots.release();
  };

  return async (): Promise<ConnectionLease | undefined> => {
    if (outside.getStore() === true) return undefined;
    const request = currentRequest();
    const share = request?.module === undefined ? undefined : shares.get(request.module);
    if (request === undefined || share === undefined) return undefined;
    // Past its deadline a request is refused what it asks next, and the lease carries the signal that cancels what it asked.
    request.signal?.throwIfAborted();
    let hold = holds.get(request);
    if (hold === undefined) {
      hold = { count: 0, granted: take(share, request.startedAt) };
      holds.set(request, hold);
    }
    hold.count += 1;
    const mine = hold;
    const granted = await mine.granted;
    if (!granted) {
      drop(request, mine, share, false);
      throw new AppError({
        code: 'DATABASE_UNAVAILABLE',
        message: `The ${share.module} module's share of the database is in use. Try again.`,
      });
    }
    let released = false;
    return {
      statementTimeoutMs: share.limits.statementTimeoutMs,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      release: (): void => {
        if (released) return;
        released = true;
        drop(request, mine, share, true);
      },
    };
  };
};
