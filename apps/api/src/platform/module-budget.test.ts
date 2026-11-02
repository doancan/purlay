import { describe, expect, test } from 'bun:test';
import { slots } from './module-budget';

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

  test('a waiter that gave up does not take a slot that is released afterwards', async () => {
    const share = slots(1);
    expect(await share.acquire(10)).toBe(true);
    expect(await share.acquire(10)).toBe(false);
    share.release();
    expect(share.inUse()).toBe(0);
    expect(await share.acquire(10)).toBe(true);
  });
});
