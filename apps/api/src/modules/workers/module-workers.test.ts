import { describe, expect, test } from 'bun:test';
import { fixedClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import { currentRequest } from '../../platform/logging';
import { aDatabaseThatMustNotBeTouched, aRecordingLogger } from '../../testing/doubles';
import {
  DEFAULT_WORKER_DEADLINE_MS,
  startWorkers,
  workerDeadlinesOf,
  workerProblem,
  type Later,
  type RunningWorker,
  type WorkerWork,
} from './module-workers';

const bus: EventBus = {
  publish: async () => {
    await Promise.resolve();
  },
  subscribe: () => true,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

/** A clock of the test's own: the loop asks for the next iteration, and the test says when it comes. */
const aManualTimer = (): {
  readonly later: Later;
  readonly pending: () => number;
  readonly fire: () => void;
  readonly waits: number[];
} => {
  const waiting: { callback: () => void; cancelled: boolean }[] = [];
  const waits: number[] = [];
  return {
    waits,
    later: (callback, milliseconds) => {
      const entry = { callback, cancelled: false };
      waiting.push(entry);
      waits.push(milliseconds);
      return (): void => {
        entry.cancelled = true;
      };
    },
    pending: () => waiting.filter((entry) => !entry.cancelled).length,
    // Fires the call a loop is waiting on, as a timer does; a cancelled one is not fired.
    fire: (): void => {
      const entry = waiting.find((candidate) => !candidate.cancelled);
      if (entry === undefined) throw new Error('nothing is waiting');
      entry.cancelled = true;
      entry.callback();
    },
  };
};

const aWorker = (work: WorkerWork, overrides: Partial<RunningWorker> = {}): RunningWorker => ({
  module: 'chat',
  name: 'deliver:scheduled',
  intervalMs: 15_000,
  deadlineMs: DEFAULT_WORKER_DEADLINE_MS,
  work,
  ...overrides,
});

const harness = (
  workers: readonly RunningWorker[],
): ReturnType<typeof startWorkers> & {
  readonly timer: ReturnType<typeof aManualTimer>;
  readonly lines: Record<string, unknown>[];
  readonly failures: Record<string, string>[];
} => {
  const timer = aManualTimer();
  const { log, lines } = aRecordingLogger();
  const failures: Record<string, string>[] = [];
  const started = startWorkers(workers, {
    database: aDatabaseThatMustNotBeTouched(),
    clock: fixedClock(new Date('2026-01-01T00:00:00Z')),
    log,
    bus,
    failures: {
      inc: (labels) => {
        failures.push(labels);
      },
    },
    later: timer.later,
  });
  return { ...started, timer, lines, failures };
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

describe('a worker’s iterations', () => {
  test('begin at once, then at the interval after the last one ended, and never overlap', async () => {
    let calls = 0;
    let finish: (() => void) | undefined;
    const run = harness([
      aWorker(async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
    ]);
    await settle();
    expect(calls).toBe(1);
    expect(run.timer.pending()).toBe(0);
    finish?.();
    await settle();
    expect(run.timer.pending()).toBe(1);
    expect(run.timer.waits).toEqual([15_000]);
    run.timer.fire();
    await settle();
    expect(calls).toBe(2);
    finish?.();
    await run.stop();
  });

  test('run as their module’s: noted as its own, so its share of the pool holds what they take', async () => {
    const seen: (string | undefined)[] = [];
    const run = harness([
      aWorker(async () => {
        seen.push(currentRequest()?.module);
        await Promise.resolve();
      }),
    ]);
    await settle();
    expect(seen).toEqual(['chat']);
    await run.stop();
  });

  test('that throw are logged with the module and the worker, counted, and followed by the next at its interval', async () => {
    let calls = 0;
    const run = harness([
      aWorker(async () => {
        calls += 1;
        await Promise.resolve();
        if (calls === 1) throw new Error('temporarily unavailable');
      }),
    ]);
    await settle();
    expect(run.failures).toEqual([{ module: 'chat', worker: 'deliver:scheduled' }]);
    expect(run.lines).toHaveLength(1);
    expect(run.lines[0]).toMatchObject({
      level: 'error',
      module: 'chat',
      worker: 'deliver:scheduled',
    });
    run.timer.fire();
    await settle();
    expect(calls).toBe(2);
    expect(run.failures).toHaveLength(1);
    await run.stop();
  });

  test('that run past the deadline are cancelled, logged and counted, and the next one runs', async () => {
    let calls = 0;
    let cancelledWith: unknown;
    const run = harness([
      aWorker(
        async () => {
          calls += 1;
          if (calls > 1) return;
          const signal = currentRequest()?.signal;
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => {
              cancelledWith = signal.reason;
              resolve();
            });
          });
        },
        { deadlineMs: 20 },
      ),
    ]);
    await Bun.sleep(60);
    expect(calls).toBe(1);
    expect(cancelledWith).toBeInstanceOf(Error);
    expect(run.failures).toEqual([{ module: 'chat', worker: 'deliver:scheduled' }]);
    expect(String((run.lines[0] as { err?: { message?: string } }).err?.message)).toContain(
      'ran past its deadline of 20 ms',
    );
    expect(run.lines[0]).toMatchObject({ module: 'chat', worker: 'deliver:scheduled' });
    run.timer.fire();
    await settle();
    expect(calls).toBe(2);
    expect(run.failures).toHaveLength(1);
    await run.stop();
  });

  test('of a module that declared no deadline are not cut off', async () => {
    let signal: AbortSignal | undefined = new AbortController().signal;
    const run = harness([
      aWorker(
        async () => {
          signal = currentRequest()?.signal;
          await Bun.sleep(30);
        },
        { deadlineMs: undefined },
      ),
    ]);
    await Bun.sleep(50);
    expect(signal).toBeUndefined();
    expect(run.failures).toEqual([]);
    await run.stop();
  });

  test('of one worker do not wait on another that is stuck', async () => {
    const ran: string[] = [];
    const run = harness([
      aWorker(
        async () => {
          await new Promise<void>(() => undefined);
        },
        { name: 'stuck' },
      ),
      aWorker(
        async () => {
          ran.push('free');
          await Promise.resolve();
        },
        { name: 'free' },
      ),
    ]);
    await settle();
    expect(ran).toEqual(['free']);
    void run.stop();
  });
});

describe('stopping the workers', () => {
  test('waits for the iteration in flight, cancels the next, and starts nothing after', async () => {
    let calls = 0;
    let finish: (() => void) | undefined;
    const run = harness([
      aWorker(async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      }),
    ]);
    await settle();
    let stopped = false;
    const stopping = run.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    finish?.();
    await stopping;
    expect(stopped).toBe(true);
    expect(run.timer.pending()).toBe(0);
    expect(calls).toBe(1);
  });

  test('also holds a call that was already due when it stopped', async () => {
    let calls = 0;
    const timer = aManualTimer();
    let due: (() => void) | undefined;
    const started = startWorkers(
      [
        aWorker(async () => {
          calls += 1;
          await Promise.resolve();
        }),
      ],
      {
        database: aDatabaseThatMustNotBeTouched(),
        clock: fixedClock(new Date('2026-01-01T00:00:00Z')),
        log: aRecordingLogger().log,
        bus,
        failures: { inc: () => undefined },
        later: (callback, milliseconds) => {
          due = callback;
          return timer.later(callback, milliseconds);
        },
      },
    );
    await settle();
    await started.stop();
    due?.();
    await settle();
    expect(calls).toBe(1);
  });
});

describe('the deadline of a module’s workers', () => {
  const deadlineOf = workerDeadlinesOf([
    { id: 'plain' },
    { id: 'quick', workerDeadline: { ms: 5_000 } },
    { id: 'patient', workerDeadline: { none: 'it waits for a person' } },
  ]);

  test('is the default for a module that says nothing, what it says otherwise, and none where it declared none', () => {
    expect(deadlineOf('plain')).toBe(DEFAULT_WORKER_DEADLINE_MS);
    expect(deadlineOf('quick')).toBe(5_000);
    expect(deadlineOf('patient')).toBeUndefined();
  });

  test('by default is longer than the pool’s wait and shorter than the longest a worker may be given', () => {
    expect(DEFAULT_WORKER_DEADLINE_MS).toBeGreaterThan(20_000);
    expect(DEFAULT_WORKER_DEADLINE_MS).toBeLessThan(3_600_000);
  });
});

describe('what a module may declare as a worker', () => {
  test('is a name like a job’s, once, and an interval from a second to an hour', () => {
    expect(workerProblem('m', [])).toBeUndefined();
    expect(
      workerProblem('m', [
        { name: 'deliver:scheduled', intervalMs: 1_000 },
        { name: 'sweep', intervalMs: 3_600_000 },
      ]),
    ).toBeUndefined();
    for (const name of ['', 'Deliver', 'a b', ':a', 'a:', '1a']) {
      expect(workerProblem('m', [{ name, intervalMs: 5_000 }])).toContain(
        `a worker called "${name}"`,
      );
    }
    expect(
      workerProblem('m', [
        { name: 'a', intervalMs: 5_000 },
        { name: 'a', intervalMs: 5_000 },
      ]),
    ).toBe('"m" has two workers called "a"');
  });
});
