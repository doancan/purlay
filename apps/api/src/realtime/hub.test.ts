/**
 * The hub's two promises that a real socket test cannot cheaply make: a thirty-day
 * expiry neither fires at once nor never, and the end of a session is announced
 * before the connection closes (#194).
 */
import { describe, expect, test } from 'bun:test';
import { CLOSE_CODES, MAX_FRAME_BYTES } from '@purlay/types';
import { aDatabaseThatMustNotBeTouched } from '../testing/doubles';
import { fixedClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
import {
  after,
  createSocketHub,
  FRAME_QUEUE_MAX,
  HELD_FRAMES_MAX,
  MAX_TIMER_MS,
  OUTBOUND_HIGH_WATER_MARK,
  type Connection,
  type Timers,
} from './hub';
import { REPLAY_BYTES_MAX } from '../modules/messages/replay';

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
      { log: createLogger({ level: 'silent' }), leave: () => undefined },
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
      { log: createLogger({ level: 'silent' }), leave: () => undefined },
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

describe('live frames held while a subscription replays', () => {
  const rig = (): { hub: ReturnType<typeof createSocketHub>; events: string[] } => {
    const hub = createSocketHub(
      aDatabaseThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      { log: createLogger({ level: 'silent' }), leave: () => undefined },
    );
    const events: string[] = [];
    void hub
      .opened(
        's',
        {
          send: (payload) =>
            events.push(`send ${(JSON.parse(payload) as { event: string }).event}`),
          buffered: () => 0,
          close: (code) => events.push(`close ${String(code)}`),
        },
        new Request('https://purlay.test/ws'),
      )
      .catch(() => undefined);
    return { hub, events };
  };

  test('nothing is written until the reply, which goes first', () => {
    const { hub, events } = rig();
    hub.hold('s');
    hub.deliver('s', { event: 'PONG', data: {}, ts: 1 });
    expect(events).toEqual([]);
    hub.reply('s', [{ event: 'ACK', data: { channels: [] }, ts: 2 }]);
    expect(events).toEqual(['send ACK', 'send PONG']);
  });

  test('after the reply, delivery is direct again', () => {
    const { hub, events } = rig();
    hub.hold('s');
    hub.reply('s', []);
    hub.deliver('s', { event: 'PONG', data: {}, ts: 1 });
    expect(events).toEqual(['send PONG']);
  });

  test('the end of a session is not kept waiting', () => {
    const { hub, events } = rig();
    hub.hold('s');
    hub.deliver('s', { event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: 1 });
    expect(events).toEqual(['send SESSION_ENDED', `close ${String(CLOSE_CODES.SESSION_ENDED)}`]);
  });

  test('a connection outrun by its own replay is closed to resync, not grown without limit', () => {
    const { hub, events } = rig();
    hub.hold('s');
    for (let i = 0; i <= HELD_FRAMES_MAX; i += 1) {
      hub.deliver('s', { event: 'PONG', data: {}, ts: i });
    }
    expect(events).toEqual([`close ${String(CLOSE_CODES.RESYNC)}`]);
  });

  test('a closed connection keeps nothing', () => {
    const { hub, events } = rig();
    hub.hold('s');
    hub.closed('s');
    hub.deliver('s', { event: 'PONG', data: {}, ts: 1 });
    hub.reply('s', [{ event: 'PONG', data: {}, ts: 2 }]);
    expect(events).toEqual([]);
    expect(hub.isOpen('s')).toBe(false);
  });
});

describe('a connection with no identity', () => {
  test('is told its session has ended and is closed, with nothing armed for it', async () => {
    const hub = createSocketHub(
      aDatabaseThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      { log: createLogger({ level: 'silent' }), leave: () => undefined },
    );
    const closes: string[] = [];
    // No cookie: nothing to look up, so the database is not reached.
    const identity = await hub.opened(
      's',
      {
        send: () => 0,
        buffered: () => 0,
        close: (code, reason) => closes.push(`${String(code)} ${reason}`),
      },
      new Request('https://purlay.test/ws'),
    );
    expect(identity).toBeUndefined();
    expect(closes).toEqual([`${String(CLOSE_CODES.SESSION_ENDED)} signed-out`]);
  });
});

describe('the frames of one connection, in turn', () => {
  const rig = (): {
    hub: ReturnType<typeof createSocketHub>;
    closes: string[];
  } => {
    const hub = createSocketHub(
      aDatabaseThatMustNotBeTouched(),
      fixedClock(new Date('2026-09-09T12:00:00.000Z')),
      { log: createLogger({ level: 'silent' }), leave: () => undefined },
    );
    const closes: string[] = [];
    void hub
      .opened(
        's',
        {
          send: () => 0,
          buffered: () => 0,
          close: (code) => closes.push(String(code)),
        },
        // No cookie: the connection is closed as signed out, which the tests ignore.
        new Request('https://purlay.test/ws'),
      )
      .catch(() => undefined);
    return { hub, closes };
  };

  const gate = (): { open: () => void; wait: Promise<void> } => {
    let open = (): void => undefined;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, wait };
  };

  test('a frame does not start until the one before it has finished, however slow', async () => {
    const { hub } = rig();
    const events: string[] = [];
    const slow = gate();
    hub.enqueue('s', async () => {
      events.push('first starts');
      await slow.wait;
      events.push('first ends');
    });
    hub.enqueue('s', async () => {
      events.push('second runs');
      await Promise.resolve();
    });
    await Bun.sleep(5);
    expect(events).toEqual(['first starts']);
    slow.open();
    await hub.settled();
    expect(events).toEqual(['first starts', 'first ends', 'second runs']);
  });

  test('a frame that fails does not stop the ones behind it', async () => {
    const { hub } = rig();
    const ran: string[] = [];
    hub.enqueue('s', async () => {
      await Promise.reject(new Error('one failed'));
    });
    hub.enqueue('s', async () => {
      ran.push('second');
      await Promise.resolve();
    });
    await hub.settled();
    expect(ran).toEqual(['second']);
  });

  test('work still queued when the connection closes never runs', async () => {
    const { hub } = rig();
    const ran: string[] = [];
    const slow = gate();
    hub.enqueue('s', async () => {
      await slow.wait;
    });
    hub.enqueue('s', async () => {
      ran.push('late');
      await Promise.resolve();
    });
    hub.closed('s');
    slow.open();
    await hub.settled();
    expect(ran).toEqual([]);
    // And a frame for a connection that has gone is dropped, not queued.
    hub.enqueue('s', async () => {
      ran.push('after');
      await Promise.resolve();
    });
    await hub.settled();
    expect(ran).toEqual([]);
  });

  test('a queue past its bound closes the connection, TOO_BUSY, and drops what was queued', async () => {
    const { hub, closes } = rig();
    const ran: number[] = [];
    const slow = gate();
    for (let i = 0; i < FRAME_QUEUE_MAX; i += 1) {
      hub.enqueue('s', async () => {
        ran.push(i);
        await slow.wait;
      });
    }
    // The first frame is under way; the other thirty-one wait behind it.
    await Bun.sleep(1);
    // The control: at the bound, nothing is refused yet.
    expect(closes.includes(String(CLOSE_CODES.TOO_BUSY))).toBe(false);
    hub.enqueue('s', async () => {
      await Promise.resolve();
    });
    expect(closes.includes(String(CLOSE_CODES.TOO_BUSY))).toBe(true);
    slow.open();
    await hub.settled();
    // Only the frame already being handled finished; the rest were dropped.
    expect(ran).toEqual([0]);
  });

  test('settled waits for work in flight, and is immediate with none', async () => {
    const { hub } = rig();
    await hub.settled();
    let finished = false;
    const slow = gate();
    hub.enqueue('s', async () => {
      await slow.wait;
      finished = true;
    });
    const waiting = hub.settled().then(() => finished);
    slow.open();
    expect(await waiting).toBe(true);
  });
});
