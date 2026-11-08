/**
 * A module's background loop runs as a module's scheduled job does (`MODULES.md` §7, §9, D-274): through the share of the
 * pool its module declared, against a deadline its manifest gives, with an error boundary that is the iteration's alone.
 *
 * A module that needs something done on a timer inside the API process — chat's scheduled messages and reminders are the
 * two there are — declares it as a worker on its slot (`BundledModule.workers`: a name, an interval and the work) and the
 * composition hands the workers of the modules this process runs to `startWorkers`. The work is given the module's leased
 * database as its only handle, so a worker can take no more of the pool than a request of its module, and past the
 * deadline its signal aborts, the lease cancels the statement running and refuses the next. A throw or a missed deadline
 * is logged with the module, counted and left behind: the next iteration comes at its interval, and the process goes on.
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import { withinRequest, type Logger } from '../../platform/logging';
import type { ModuleManifest } from '../../platform/module-kit/manifest';
import type { Counter } from '../../platform/metrics';
import { withDeadline } from '../../platform/request-deadline';
import {
  eachEntitled,
  markPerWorkspace,
  noEntitledWorkspaces,
  type EntitledFor,
  type EntitledWorkspaces,
} from '../../platform/entitled-workspaces';
import type { WorkspaceScope } from '../../platform/ports/record-ref';
import { noPorts, type ModulePorts, type PortsFor } from '../../platform/ports/module-ports';
import type { OutboxCounters } from '../../platform/outbox-drain';
import type { PushSender } from '../push/sender';

/**
 * Past a delivery's batch on a busy instance and a few intervals of the loops there are, and under the pool's thirty-second
 * statement limit twice over: an iteration that hangs holds only its own worker, and the next is tried after this.
 */
export const DEFAULT_WORKER_DEADLINE_MS = 60_000;

/** The interval a worker may declare: not tighter than a second, so a loop is never a busy one, and an hour at the longest. */
const WORKER_INTERVAL_MS_MIN = 1_000;
const WORKER_INTERVAL_MS_MAX = 3_600_000;

/** What the work of a worker is given: the process's own handles and the module's share of the connections. */
interface WorkerContext {
  /** The module's lease of the pool: the work opens no connection of its own. */
  readonly database: Executor;
  readonly clock: Clock;
  /** Names the module and the worker on every line. */
  readonly log: Logger;
  readonly bus: EventBus;
  /** The ports of what the module `uses`, reading through `database`: ask them for each workspace the work touches (D-283 §3). */
  readonly ports: ModulePorts;
  /** The workspaces the module may act for now (D-289): for a loop that acts for workspaces, `perWorkspaceWorker` walks them. */
  readonly entitled: EntitledWorkspaces;
  /** Where the process has Web Push on. */
  readonly push?: PushSender;
  /** What the outbox worker of a module counts into, where the process records metrics. */
  readonly outbox?: OutboxCounters;
}

/** One iteration of a worker. A throw is the iteration's failure and nothing more. */
export type WorkerWork = (context: WorkerContext) => Promise<void>;

/**
 * The work of a loop that acts for workspaces, written for one: `visit` is called for each workspace the module may act for
 * when the iteration reaches it, with the modules that workspace may use (so `ports.of(turn)` is right for it), and for no other.
 * A module that is a grant may declare no other kind of worker (`unguardedWorkProblem`, D-289).
 */
export const perWorkspaceWorker = (
  visit: (turn: WorkspaceScope, context: WorkerContext) => Promise<void>,
): WorkerWork =>
  markPerWorkspace(async (context) => {
    await eachEntitled(context.entitled, async (turn) => {
      await visit(turn, context);
    });
  });

/** What a module declares: the work, how often it is done and the name its lines and its counter carry. */
export interface ModuleWorker {
  /** Like a job's: lowercase words with colons, as `deliver:scheduled`. The module's alone. */
  readonly name: string;
  /** Between the end of one iteration and the start of the next: iterations of a worker never overlap. */
  readonly intervalMs: number;
  readonly work: WorkerWork;
}

/** A worker of a module this process runs, with the deadline its module's manifest gives. */
export interface RunningWorker extends ModuleWorker {
  readonly module: string;
  /** `undefined` for a module that declared `none`. */
  readonly deadlineMs: number | undefined;
}

/** The deadline of a module's workers in milliseconds, `undefined` for one that declared `none`. */
export const workerDeadlinesOf = (
  manifests: readonly Pick<ModuleManifest, 'id' | 'workerDeadline'>[],
): ((moduleId: string) => number | undefined) => {
  const byModule = new Map(
    manifests.map(({ id, workerDeadline }) => [
      id,
      workerDeadline === undefined
        ? DEFAULT_WORKER_DEADLINE_MS
        : 'ms' in workerDeadline
          ? workerDeadline.ms
          : undefined,
    ]),
  );
  return (moduleId) => byModule.get(moduleId);
};

const WORKER_NAME = /^[a-z][a-z0-9]*(?::[a-z][a-z0-9-]*)*$/;

/** What is wrong with the workers a module supplies, or `undefined` when each is named and timed as a worker may be. */
export const workerProblem = (
  module: string,
  workers: readonly Pick<ModuleWorker, 'name' | 'intervalMs'>[],
): string | undefined => {
  const seen = new Set<string>();
  for (const { name, intervalMs } of workers) {
    if (!WORKER_NAME.test(name)) {
      return `"${module}" has a worker called "${name}", which is not a name like "deliver:scheduled"`;
    }
    if (seen.has(name)) return `"${module}" has two workers called "${name}"`;
    seen.add(name);
    if (
      !Number.isInteger(intervalMs) ||
      intervalMs < WORKER_INTERVAL_MS_MIN ||
      intervalMs > WORKER_INTERVAL_MS_MAX
    ) {
      return `"${module}" has the worker "${name}" run every ${String(intervalMs)} ms: it needs a whole number from ${String(WORKER_INTERVAL_MS_MIN)} to ${String(WORKER_INTERVAL_MS_MAX)}`;
    }
  }
  return undefined;
};

/** An iteration that went past its deadline: the work was cancelled and the iteration is counted as failed. */
class WorkerDeadlineError extends Error {
  constructor(worker: string, module: string, ms: number) {
    super(
      `The worker "${worker}" of the ${module} module ran past its deadline of ${String(ms)} ms and was stopped.`,
    );
    this.name = 'WorkerDeadlineError';
  }
}

/** Calls `callback` after `milliseconds` and returns what cancels the call: the clock of a loop, a test's to drive. */
export type Later = (callback: () => void, milliseconds: number) => () => void;

const timeoutLater: Later = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return (): void => {
    clearTimeout(timer);
  };
};

export interface WorkersDependencies {
  /** Already leased: every connection the work takes is asked of its module's share (`leasingExecutor`). */
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly bus: EventBus;
  readonly push?: PushSender;
  readonly outbox?: OutboxCounters;
  /** The composition's `portsFor`; left out, a worker has no ports. */
  readonly portsFor?: PortsFor;
  /** The composition's `entitledFor`; left out, a worker has no workspace to act for. */
  readonly entitledFor?: EntitledFor;
  /** `purlay_worker_failures_total`: one series for each worker the build carries, made at zero by `serverMetrics`. */
  readonly failures: Counter<'module' | 'worker'>;
  /** The modules the administrator has stopped (D-296), as fresh as the TTL: a worker of one of them does not run its iteration. */
  readonly suspended?: () => Promise<ReadonlySet<string>>;
  readonly later?: Later;
}

export interface Workers {
  /** Stops the next iterations and waits for the ones in flight, which their deadlines bound. */
  readonly stop: () => Promise<void>;
}

/**
 * Starts each worker: the first iteration at once and the next one `intervalMs` after the last ends, one flight a worker.
 * A worker's module is the one the composition gave it, which is the one whose share and deadline hold it.
 */
export const startWorkers = (
  workers: readonly RunningWorker[],
  dependencies: WorkersDependencies,
): Workers => {
  const {
    database,
    clock,
    bus,
    push,
    outbox,
    failures,
    suspended,
    portsFor,
    entitledFor,
    later = timeoutLater,
  } = dependencies;
  let stopped = false;
  const loops = workers.map((worker) => {
    const { module, name, work, deadlineMs } = worker;
    const log = dependencies.log.child({ module, worker: name });
    const ports = portsFor?.(module, database) ?? noPorts;
    const entitled = entitledFor?.(module, database) ?? noEntitledWorkspaces;
    const iteration = async (): Promise<void> => {
      // A stopped module claims nothing and sweeps nothing; its rows wait for it (D-296).
      if ((await suspended?.())?.has(module) === true) return;
      const run = async (signal?: AbortSignal): Promise<void> => {
        await withinRequest(
          {
            requestId: `worker:${module}:${name}`,
            startedAt: performance.now(),
            module,
            ...(signal === undefined ? {} : { signal }),
          },
          async () => {
            await work({
              database,
              clock,
              log,
              bus,
              ports,
              entitled,
              ...(push === undefined ? {} : { push }),
              ...(outbox === undefined ? {} : { outbox }),
            });
          },
        );
      };
      try {
        if (deadlineMs === undefined) {
          await run();
          return;
        }
        const overran = await withDeadline<boolean>(
          deadlineMs,
          async (signal) => {
            await run(signal);
            return false;
          },
          () => true,
        );
        if (overran) throw new WorkerDeadlineError(name, module, deadlineMs);
      } catch (error) {
        failures.inc({ module, worker: name });
        log.error('worker failed; trying again at its next interval', { err: error });
      }
    };
    let cancel: (() => void) | undefined;
    let flight: Promise<void> = Promise.resolve();
    const tick = (): void => {
      if (stopped) return;
      flight = iteration().finally(() => {
        if (!stopped) cancel = later(tick, worker.intervalMs);
      });
    };
    tick();
    return {
      stop: async (): Promise<void> => {
        cancel?.();
        await flight;
      },
    };
  });
  return {
    stop: async (): Promise<void> => {
      stopped = true;
      await Promise.all(
        loops.map(async (loop) => {
          await loop.stop();
        }),
      );
    },
  };
};
