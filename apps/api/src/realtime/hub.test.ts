/**
 * The hub's two promises that a real socket test cannot cheaply make: a thirty-day
 * expiry neither fires at once nor never, and the end of a session is announced
 * before the connection closes (#194).
 */
import { describe, expect, test } from 'bun:test';
import { CLOSE_CODES, MAX_FRAME_BYTES } from '@purlay/types';
import { aDatabaseThatMustNotBeTouched } from '../ingress/http/testing';
import { fixedClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
import {
  after,
  createSocketHub,
  MAX_TIMER_MS,
  OUTBOUND_HIGH_WATER_MARK,
  type Connection,
  type Timers,
} from './hub';
import { REPLAY_BYTES_MAX } from './router';

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
      { log: createLogger({ level: 'silent' }) },
    );
    const events: string[] = [];
    // Registered without resolving an identity: delivery does not depend on one.
    void hub
      .opened(
        'socket-1',
        {
          send: (payload) => events.push(`send ${payload}`),
          buffered: () => 0,
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

describe('a connection that falls behind (#197)', () => {
  const connectionWith = (
    written: number,
    buffered: number,
  ): { connection: Connection; closes: string[] } => {
    const closes: string[] = [];
    return {
      closes,
      connection: {
        send: () => written,
        buffered: () => buffered,
        close: (code: number, reason: string): void => {
          closes.push(`${String(code)} ${reason}`);
        },
      },
    };
  };

  const deliverTo = (connection: Connection): void => {
    const hub = createSocketHub(
      aDatabaseThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      { log: createLogger({ level: 'silent' }) },
    );
    void hub.opened('s', connection, new Request('https://purlay.test/ws')).catch(() => undefined);
    hub.deliver('s', { event: 'PONG', data: {}, ts: 0 });
  };

  test('a frame the transport dropped closes the connection to resync', () => {
    const { connection, closes } = connectionWith(0, 0);
    deliverTo(connection);
    expect(closes).toEqual([`${String(CLOSE_CODES.RESYNC)} resync`]);
  });

  test('a queue past the mark closes it; one at the mark does not', () => {
    const over = connectionWith(-1, OUTBOUND_HIGH_WATER_MARK + 1);
    deliverTo(over.connection);
    expect(over.closes).toEqual([`${String(CLOSE_CODES.RESYNC)} resync`]);

    const at = connectionWith(-1, OUTBOUND_HIGH_WATER_MARK);
    deliverTo(at.connection);
    expect(at.closes).toEqual([]);
  });

  /**
   * A healthy reader receives a replay as one burst. If the mark were below it,
   * the reader would be closed by its own replay, reconnect, replay again, and
   * loop. A loopback socket drains too fast to show that, so the relation itself
   * is the test.
   */
  test('the mark exceeds the largest burst a healthy connection is sent', () => {
    expect(OUTBOUND_HIGH_WATER_MARK).toBeGreaterThan(REPLAY_BYTES_MAX + MAX_FRAME_BYTES);
  });
});
