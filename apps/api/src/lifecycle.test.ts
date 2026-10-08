/**
 * The shutdown's order and its two ways out, without a process (#220).
 */
import { describe, expect, test } from 'bun:test';
import { createLogger } from './platform/logging';
import { installShutdown, type ProcessLike } from './lifecycle';
import type { Timers } from './realtime/hub';

const harness = (
  drain: () => Promise<void>,
): {
  steps: string[];
  fireDeadline: () => void;
  signal: (name: 'SIGTERM' | 'SIGINT') => void;
  start: (signal: string) => Promise<void>;
} => {
  const steps: string[] = [];
  const handlers = new Map<string, () => void>();
  let deadline: (() => void) | undefined;
  const process: ProcessLike = {
    on: (signal, handler) => {
      handlers.set(signal, handler);
    },
    exit: (code) => {
      steps.push(`exit ${String(code)}`);
    },
  };
  const timers: Timers = {
    set: (callback) => {
      deadline = callback;
      return 1;
    },
    clear: () => {
      steps.push('deadline cleared');
      deadline = undefined;
    },
  };
  const start = installShutdown({
    drain: async () => {
      steps.push('drain');
      await drain();
    },
    closeDatabase: async () => {
      steps.push('database closed');
      await Promise.resolve();
    },
    log: createLogger({ level: 'silent' }),
    process,
    deadlineMs: 10_000,
    timers,
  });
  return {
    steps,
    start,
    fireDeadline: () => deadline?.(),
    signal: (name) => handlers.get(name)?.(),
  };
};

describe('shutting down', () => {
  test('drains, then closes the pool, then exits 0 — and the deadline is cleared', async () => {
    const run = harness(async () => {
      await Promise.resolve();
    });
    await run.start('SIGTERM');
    expect(run.steps).toEqual(['drain', 'database closed', 'deadline cleared', 'exit 0']);
  });

  test('both signals are wired, and a second does not start a second shutdown', async () => {
    const run = harness(async () => {
      await Bun.sleep(5);
    });
    run.signal('SIGTERM');
    run.signal('SIGINT');
    await Bun.sleep(20);
    expect(run.steps.filter((step) => step === 'drain')).toHaveLength(1);
    expect(run.steps.at(-1)).toBe('exit 0');
  });

  test('a drain that never finishes is cut off at the deadline, with exit 1', () => {
    const run = harness(async () => {
      await new Promise<void>(() => undefined);
    });
    void run.start('SIGTERM');
    run.fireDeadline();
    expect(run.steps).toEqual(['drain', 'exit 1']);
  });

  test('a drain that fails exits 1 rather than hanging', async () => {
    const run = harness(async () => {
      await Promise.reject(new Error('the listener would not stop'));
    });
    await run.start('SIGTERM');
    expect(run.steps).toEqual(['drain', 'deadline cleared', 'exit 1']);
  });
});
