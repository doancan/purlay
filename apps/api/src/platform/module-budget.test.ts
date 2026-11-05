import { describe, expect, test } from 'bun:test';
import type { ConnectionLease } from '@purlay/db';
import { AppError } from './errors';
import { withinRequest } from './logging';
import {
  coreReserve,
  moduleConnections,
  inTheCore,
  slots,
  type ModuleBudget,
} from './module-budget';

describe('the slots of a module', () => {
  test('are given while there are some, and a request over the limit waits and is refused when it times out', async () => {
    const share = slots(2);
    expect(await share.acquire(10)).toBe(true);
    expect(await share.acquire(10)).toBe(true);
    expect(share.inUse()).toBe(2);
    expect(await share.acquire(20)).toBe(false);
    expect(share.inUse()).toBe(2);
  });

  test('pass to the one that has waited longest, and are never over the limit while they do', async () => {
    const share = slots(1);
    expect(await share.acquire(10)).toBe(true);
    const order: string[] = [];
    const first = share.acquire(500).then((granted) => order.push(`first:${String(granted)}`));
    const second = share.acquire(500).then((granted) => order.push(`second:${String(granted)}`));
    share.release();
    await first;
    expect(share.inUse()).toBe(1);
    share.release();
    await second;
    expect(order).toEqual(['first:true', 'second:true']);
    share.release();
    expect(share.inUse()).toBe(0);
  });

  test('pass to the lowest rank waiting, which is the oldest request, whatever the order of asking', async () => {
    const share = slots(1);
    expect(await share.acquire(10)).toBe(true);
    const order: string[] = [];
    const later = share.acquire(500, 20).then(() => order.push('later'));
    const older = share.acquire(500, 10).then(() => order.push('older'));
    const alsoLater = share.acquire(500, 20).then(() => order.push('also later'));
    share.release();
    await older;
    share.release();
    await later;
    share.release();
    await alsoLater;
    expect(order).toEqual(['older', 'later', 'also later']);
  });

  test('a waiter that gave up does not take a slot that is released afterwards', async () => {
    const share = slots(1);
    expect(await share.acquire(10)).toBe(true);
    expect(await share.acquire(10)).toBe(false);
    share.release();
    expect(share.inUse()).toBe(0);
    expect(await share.acquire(10)).toBe(true);
  });
});

const BUDGET: ModuleBudget = { maxConcurrent: 2, queueTimeoutMs: 30, statementTimeoutMs: 5_000 };

/** A request or frame of `module`, as the router notes it, or of nobody's. */
const asRequest = async <T>(module: string | undefined, body: () => Promise<T>): Promise<T> =>
  await withinRequest(
    { requestId: crypto.randomUUID(), startedAt: 0, ...(module === undefined ? {} : { module }) },
    body,
  );

const refusalOf = async (call: () => Promise<unknown>): Promise<unknown> => {
  try {
    await call();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('the lease of a module of a build', () => {
  const manifests = [
    { id: 'shared', budget: { poolShare: (): ModuleBudget => BUDGET } },
    { id: 'other', budget: { poolShare: (): ModuleBudget => BUDGET } },
    { id: 'alone', budget: { none: 'a module nothing is kept from' } },
  ] as const;

  test('is the share a module declares: a request over it is refused as the database being busy, after waiting its turn', async () => {
    const lease = moduleConnections(manifests, 10);
    const first = await asRequest('shared', lease);
    const second = await asRequest('shared', lease);
    expect(first?.statementTimeoutMs).toBe(5_000);
    const refused = await refusalOf(async () => await asRequest('shared', lease));
    expect(refused).toBeInstanceOf(AppError);
    expect((refused as AppError).body.code).toBe('DATABASE_UNAVAILABLE');
    first?.release();
    expect(await asRequest('shared', lease)).toBeDefined();
    second?.release();
  });

  test('holds one slot for a request however many connections it takes, so that it cannot wait for itself', async () => {
    const lease = moduleConnections(
      [
        {
          id: 'shared',
          budget: { poolShare: (): ModuleBudget => ({ ...BUDGET, maxConcurrent: 1 }) },
        },
      ],
      10,
    );
    await asRequest('shared', async () => {
      const outer = await lease();
      const inner = await lease();
      expect(inner).toBeDefined();
      outer?.release();
      // Still held by the inner: another request has no slot yet.
      const other = await refusalOf(async () => await asRequest('shared', lease));
      expect(other).toBeInstanceOf(AppError);
      inner?.release();
    });
    expect(await asRequest('shared', lease)).toBeDefined();
  });

  test('is given back once, however many times it is told', async () => {
    const lease = moduleConnections(
      [
        {
          id: 'shared',
          budget: { poolShare: (): ModuleBudget => ({ ...BUDGET, maxConcurrent: 1 }) },
        },
      ],
      10,
    );
    const held = await asRequest('shared', lease);
    held?.release();
    held?.release();
    const next = await asRequest('shared', lease);
    expect(next).toBeDefined();
    expect(await refusalOf(async () => await asRequest('shared', lease))).toBeInstanceOf(AppError);
  });

  test('holds nobody but the module of the request: the core, a module that declared none and a path no module owns take none', async () => {
    const lease = moduleConnections(manifests, 10);
    expect(await asRequest(undefined, lease)).toBeUndefined();
    expect(await asRequest('alone', lease)).toBeUndefined();
    expect(await asRequest('unknown', lease)).toBeUndefined();
    expect(await lease()).toBeUndefined();
  });

  test('carries the signal of a request past its deadline, and refuses what the request asks after it', async () => {
    const lease = moduleConnections(manifests, 10);
    const controller = new AbortController();
    const scope = {
      requestId: crypto.randomUUID(),
      startedAt: 0,
      module: 'shared',
      signal: controller.signal,
    };
    const held = await withinRequest(scope, lease);
    expect(held?.signal).toBe(controller.signal);
    held?.release();
    controller.abort(new Error('past its deadline'));
    const refused = await refusalOf(async () => await withinRequest(scope, lease));
    expect(String(refused)).toContain('past its deadline');
    // Nothing was taken for it: the share is whole.
    expect(await asRequest('shared', lease)).toBeDefined();
    expect(await asRequest('shared', lease)).toBeDefined();
  });

  test('does not hold the core work inside a module request', async () => {
    const lease = moduleConnections(manifests, 10);
    const [a, b] = [await asRequest('shared', lease), await asRequest('shared', lease)];
    const inside = await asRequest('shared', async () => await inTheCore(lease)());
    expect(inside).toBeUndefined();
    a?.release();
    b?.release();
  });

  test('keeps the core a part of the pool: modules together take the pool less its reserve, however large their shares', async () => {
    const wide = (): ModuleBudget => ({ ...BUDGET, maxConcurrent: 9 });
    const lease = moduleConnections(
      [
        { id: 'shared', budget: { poolShare: wide } },
        { id: 'other', budget: { poolShare: wide } },
      ],
      10,
    );
    const together = 10 - coreReserve(10);
    const held: (ConnectionLease | undefined)[] = [];
    for (let n = 0; n < together; n += 1)
      held.push(await asRequest(n % 2 === 0 ? 'shared' : 'other', lease));
    expect(held.every((each) => each !== undefined)).toBe(true);
    expect(await refusalOf(async () => await asRequest('shared', lease))).toBeInstanceOf(AppError);
    expect(await refusalOf(async () => await asRequest('other', lease))).toBeInstanceOf(AppError);
    // The refusals gave nothing back that was not theirs: one release lets the next in.
    held[0]?.release();
    expect(await asRequest('shared', lease)).toBeDefined();
  });
});

describe('what the core keeps of the pool', () => {
  test('is a fifth, at least one, and nothing in a pool of one', () => {
    expect([1, 2, 5, 10, 30, 100].map(coreReserve)).toEqual([0, 1, 1, 2, 6, 20]);
  });
});
