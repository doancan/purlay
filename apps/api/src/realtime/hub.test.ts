/**
 * The hub's two promises that a real socket test cannot cheaply make: a thirty-day
 * expiry neither fires at once nor never, and the end of a session is announced
 * before the connection closes (#194).
 */
import { describe, expect, test } from 'bun:test';
import { CLOSE_CODES } from '@purlay/types';
import { aDatabaseThatMustNotBeTouched } from '../ingress/http/testing';
import { fixedClock } from '../platform/clock';
import { after, createSocketHub, MAX_TIMER_MS, type Timers } from './hub';

/** Timers that record what was asked of them and fire only when told. */
const recordedTimers = (): Timers & {
  readonly pending: { readonly ms: number; readonly fire: () => void }[];
  readonly cleared: unknown[];
} => {
  const pending: { ms: number; fire: () => void; handle: number }[] = [];
  const cleared: unknown[] = [];
  let next = 0;
  return {
    pending,
    cleared,
    set: (callback: () => void, ms: number): number => {
      next += 1;
      pending.push({ ms, fire: callback, handle: next });
      return next;
    },
    clear: (handle: unknown): void => {
      cleared.push(handle);
    },
  };
};

const DAY = 24 * 60 * 60 * 1000;

describe('a timer longer than a JavaScript timer allows', () => {
  test('is chained in links the runtime honours, and fires once, at the end', () => {
    const timers = recordedTimers();
    let fired = 0;
    after(timers, 30 * DAY, () => {
      fired += 1;
    });

    expect(timers.pending.map((t) => t.ms)).toEqual([MAX_TIMER_MS]);
    timers.pending[0]?.fire();
    expect(fired).toBe(0);
    expect(timers.pending.map((t) => t.ms)).toEqual([MAX_TIMER_MS, 30 * DAY - MAX_TIMER_MS]);
    timers.pending[1]?.fire();
    expect(fired).toBe(1);
  });

  test('a short one is a single timer, and a past one fires as soon as it can', () => {
    const timers = recordedTimers();
    after(timers, 500, () => undefined);
    after(timers, -5_000, () => undefined);
    expect(timers.pending.map((t) => t.ms)).toEqual([500, 0]);
  });

  test('cancelling clears whichever link is pending', () => {
    const timers = recordedTimers();
    const cancel = after(timers, 30 * DAY, () => undefined);
    timers.pending[0]?.fire();
    cancel();
    expect(timers.cleared).toEqual([2]);
  });
});

describe('the end of a session, on a connection', () => {
  test('is announced, then the connection is closed with the code that says why', () => {
    const hub = createSocketHub(
      aDatabaseThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
    );
    const events: string[] = [];
    // Registered without resolving an identity: delivery does not depend on one.
    void hub
      .opened(
        'socket-1',
        {
          send: (payload) => events.push(`send ${payload}`),
          close: (code, reason) => events.push(`close ${String(code)} ${reason}`),
        },
        new Request('https://purlay.test/ws'),
      )
      .catch(() => undefined);

    hub.deliver('socket-1', { event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: 0 });
    expect(events).toEqual([
      'send {"event":"SESSION_ENDED","data":{"reason":"signed-out"},"ts":0}',
      `close ${String(CLOSE_CODES.SESSION_ENDED)} signed-out`,
    ]);
  });
});
