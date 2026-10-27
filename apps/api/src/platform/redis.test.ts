/**
 * The Redis link (D-201): it connects both ways, replaces a lost connection with a new one after a wait that
 * grows, subscribes again on it and says that frames were missed, never waits for a connection on a command,
 * stays quiet about where Redis is, and leaves nothing running when closed.
 */
import { describe, expect, test } from 'bun:test';
import { aRecordingLogger } from '../testing/doubles';
import { refusedWith } from '../testing/redis';
import {
  COMMAND_TIMEOUT_MS,
  KEEPALIVE_MS,
  RECONNECT_BASE_MS,
  STABLE_MS,
  RECONNECT_MAX_MS,
  connectRedis,
  type RedisClientLike,
  type RedisLink,
  type RedisTimers,
} from './redis';

class FakeClient implements RedisClientLike {
  closed = false;
  readonly subscribed: string[] = [];
  readonly sent: { command: string; args: readonly string[] }[] = [];
  listeners = new Map<string, (message: string) => void>();
  private lost: ((error: Error) => void) | undefined;
  private readonly outcome: 'connects' | 'refuses';
  private readonly reply: () => Promise<unknown>;
  constructor(
    outcome: 'connects' | 'refuses',
    reply: () => Promise<unknown> = () => Promise.resolve('OK'),
  ) {
    this.outcome = outcome;
    this.reply = reply;
  }
  connect = async (): Promise<void> => {
    await Promise.resolve();
    if (this.outcome === 'refuses') throw new Error('connection refused');
  };
  close = (): void => {
    this.closed = true;
    this.lost?.(new Error('Connection closed'));
  };
  send = async (command: string, args: readonly string[]): Promise<unknown> => {
    this.sent.push({ command, args });
    return await this.reply();
  };
  subscribe = async (channel: string, listener: (message: string) => void): Promise<void> => {
    await Promise.resolve();
    this.subscribed.push(channel);
    this.listeners.set(channel, listener);
  };
  onClose = (handler: (error: Error) => void): void => {
    this.lost = handler;
  };
  /** The server went away. */
  drop = (): void => {
    this.lost?.(new Error('Connection closed'));
  };
}

const timersRecorded = (): RedisTimers & {
  readonly armed: { ms: number; fire: () => void; cleared: boolean }[];
  readonly next: () => number;
} => {
  const armed: { ms: number; fire: () => void; cleared: boolean }[] = [];
  return {
    armed,
    set: (fire, ms): number => {
      armed.push({ ms, fire, cleared: false });
      return armed.length - 1;
    },
    clear: (handle): void => {
      const timer = armed[handle as number];
      if (timer !== undefined) timer.cleared = true;
    },
    /** Fires the oldest reconnection still waiting and returns the wait it had. */
    next: (): number => {
      const timer = armed.find(
        (t) =>
          !t.cleared && t.ms !== KEEPALIVE_MS && t.ms !== STABLE_MS && t.ms !== COMMAND_TIMEOUT_MS,
      );
      if (timer === undefined) throw new Error('no timer is armed');
      timer.cleared = true;
      timer.fire();
      return timer.ms;
    },
  };
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();
};

const world = (
  outcomes: ('connects' | 'refuses')[],
  reply?: () => Promise<unknown>,
): {
  readonly link: RedisLink;
  readonly clients: FakeClient[];
  readonly timers: ReturnType<typeof timersRecorded>;
  readonly lines: Record<string, unknown>[];
} => {
  const clients: FakeClient[] = [];
  const timers = timersRecorded();
  const { log, lines } = aRecordingLogger();
  let made = 0;
  const link = connectRedis({
    create: () => {
      const outcome = outcomes[made] ?? 'connects';
      made += 1;
      const client = new FakeClient(outcome, reply);
      clients.push(client);
      return client;
    },
    log,
    timers,
    jitter: () => 1,
  });
  return { link, clients, timers, lines };
};

describe('the Redis link', () => {
  test('opens a connection for commands and one for the subscription, and is connected when both are up', async () => {
    const w = world([]);
    expect(w.link.connected()).toBe(false);
    expect(w.link.problem()).toBeDefined();
    await settle();
    expect(w.clients).toHaveLength(2);
    expect(w.link.connected()).toBe(true);
    expect(w.link.subscribed()).toBe(true);
    expect(w.link.problem()).toBeUndefined();
  });

  test('a command is sent on the connection for commands, a script as EVAL with its keys first', async () => {
    const w = world([]);
    await settle();
    await w.link.send('PING', []);
    await w.link.script('return 1', ['k1', 'k2'], ['a']);
    const sent = w.clients[0]?.sent;
    expect(sent).toEqual([
      { command: 'PING', args: [] },
      { command: 'EVAL', args: ['return 1', '2', 'k1', 'k2', 'a'] },
    ]);
    expect(w.clients[1]?.sent).toEqual([]);
  });

  test('a command made while the first connection is still being made fails at once too', async () => {
    const w = world([]);
    expect(await refusedWith(w.link.send('PING', []))).toContain('not connected');
    await settle();
    expect(w.clients[0]?.sent).toEqual([]);
  });

  test('a command made while not connected fails at once, and never queues', async () => {
    const w = world(['refuses']);
    await settle();
    expect(await refusedWith(w.link.send('PING', []))).toContain('not connected');
    expect(w.clients[0]?.sent).toEqual([]);
  });

  test('a command that is never answered fails after its timeout, and its timer is cleared', async () => {
    const w = world([], () => new Promise<unknown>(() => undefined));
    await settle();
    const pending = w.link.send('PING', []);
    await settle();
    const timeout = w.timers.armed.find((t) => t.ms === COMMAND_TIMEOUT_MS);
    expect(timeout).toBeDefined();
    timeout?.fire();
    expect(await refusedWith(pending)).toContain('timed out');
  });

  test('a refused connection is tried again after a wait that doubles to a ceiling, and never throws', async () => {
    const w = world(Array.from({ length: 12 }, () => 'refuses' as const));
    await settle();
    // Both connections refused: two timers, each the first wait.
    const waits: number[] = [];
    for (let round = 0; round < 6; round += 1) {
      const before = w.timers.armed.filter((t) => !t.cleared).length;
      expect(before).toBeGreaterThan(0);
      waits.push(w.timers.next());
      await settle();
    }
    expect(waits[0]).toBe(RECONNECT_BASE_MS);
    expect(waits.slice(0, 4)).toEqual([
      RECONNECT_BASE_MS,
      RECONNECT_BASE_MS,
      RECONNECT_BASE_MS * 2,
      RECONNECT_BASE_MS * 2,
    ]);
    expect(Math.max(...waits)).toBeLessThanOrEqual(RECONNECT_MAX_MS);
    expect(w.link.problem()).toBeDefined();
  });

  test('a lost connection is replaced by a new client, which subscribes again; the listener is told what was missed', async () => {
    const w = world([]);
    const heard: string[] = [];
    w.link.subscribe('bus', (message) => {
      heard.push(message);
    });
    let gaps = 0;
    w.link.onResubscribed(() => {
      gaps += 1;
    });
    await settle();
    expect(w.clients[1]?.subscribed).toEqual(['bus']);
    expect(gaps).toBe(0);

    w.clients[1]?.drop();
    expect(w.link.subscribed()).toBe(false);
    w.timers.next();
    await settle();

    expect(w.clients).toHaveLength(3);
    expect(w.clients[1]?.closed).toBe(true);
    expect(w.clients[2]?.subscribed).toEqual(['bus']);
    expect(w.link.subscribed()).toBe(true);
    expect(gaps).toBe(1);
    w.clients[2]?.listeners.get('bus')?.('hello');
    expect(heard).toEqual(['hello']);
  });

  test('losing the connection for commands is not a gap: nothing is published to this process on it', async () => {
    const w = world([]);
    let gaps = 0;
    w.link.onResubscribed(() => {
      gaps += 1;
    });
    await settle();
    w.clients[0]?.drop();
    expect(w.link.connected()).toBe(false);
    expect(w.link.subscribed()).toBe(true);
    w.timers.next();
    await settle();
    expect(w.link.connected()).toBe(true);
    expect(gaps).toBe(0);
  });

  test('a channel registered after the connection is up is subscribed at once', async () => {
    const w = world([]);
    await settle();
    w.link.subscribe('late', () => undefined);
    await settle();
    expect(w.clients[1]?.subscribed).toEqual(['late']);
  });

  test('a node that has been reached once is ready for good: a later loss is degraded, never unready', async () => {
    const w = world([]);
    await settle();
    w.clients[0]?.drop();
    w.clients[1]?.drop();
    expect(w.link.connected()).toBe(false);
    expect(w.link.problem()).toBeUndefined();
  });

  test('says that Redis was lost and why, and never where it is', async () => {
    const w = world([]);
    await settle();
    w.clients[0]?.drop();
    const lost = w.lines.find((line) => line['msg'] === 'redis connection lost; reconnecting');
    expect(lost).toMatchObject({ role: 'commands', err: 'Connection closed' });
    expect(JSON.stringify(w.lines)).not.toContain('redis://');
  });

  test('closing stops every retry, closes both connections, and is safe twice', async () => {
    const w = world(['refuses', 'connects']);
    await settle();
    const retry = w.timers.armed.find(
      (t) => !t.cleared && t.ms !== KEEPALIVE_MS && t.ms !== STABLE_MS,
    );
    expect(retry).toBeDefined();
    w.link.close();
    w.link.close();
    expect(w.timers.armed.every((t) => t.cleared)).toBe(true);
    expect(w.clients.every((client) => client.closed)).toBe(true);
    // A retry that was already on its way finds the link closed and opens nothing.
    const before = w.clients.length;
    retry?.fire();
    expect(w.clients).toHaveLength(before);
    expect(w.link.connected()).toBe(false);
  });

  test('a connection that comes up after the link was closed is closed again, not kept', async () => {
    const w = world([]);
    w.link.close();
    await settle();
    expect(w.clients.every((client) => client.closed)).toBe(true);
    expect(w.link.connected()).toBe(false);
  });

  test('a connection that goes silent without closing is found by its keepalive and made again', async () => {
    const w = world([]);
    await settle();
    // The second: the subscription's, after the commands'.
    const alive = w.timers.armed.filter((t) => !t.cleared && t.ms === KEEPALIVE_MS)[1];
    expect(alive).toBeDefined();
    // The ping is never answered: the timeout that races it fires.
    const client = w.clients[1]!;
    client.send = (): Promise<unknown> => new Promise<unknown>(() => undefined);
    alive?.fire();
    await settle();
    w.timers.armed
      .filter((t) => !t.cleared && t.ms === COMMAND_TIMEOUT_MS)
      .at(-1)
      ?.fire();
    await settle();
    expect(w.link.subscribed()).toBe(false);
    expect(client.closed).toBe(true);
  });

  test('an answered keepalive arms the next one, and leaves the connection alone', async () => {
    const w = world([]);
    await settle();
    w.timers.armed.find((t) => !t.cleared && t.ms === KEEPALIVE_MS)?.fire();
    await settle();
    expect(w.link.connected()).toBe(true);
    expect(
      w.timers.armed.filter((t) => !t.cleared && t.ms === KEEPALIVE_MS).length,
    ).toBeGreaterThan(0);
  });

  test('a command that is never answered ends its connection, so the next ones do not wait too', async () => {
    const w = world([], () => new Promise<unknown>(() => undefined));
    await settle();
    const pending = w.link.send('GET', ['k']);
    await settle();
    w.timers.armed.find((t) => !t.cleared && t.ms === COMMAND_TIMEOUT_MS)?.fire();
    expect(await refusedWith(pending)).toContain('timed out');
    expect(w.link.connected()).toBe(false);
    expect(w.clients[0]?.closed).toBe(true);
  });

  test('the wait to retry starts over only after the connection has held, not as it comes up', async () => {
    const w = world([]);
    await settle();
    w.clients[0]?.drop();
    expect(w.timers.next()).toBe(RECONNECT_BASE_MS);
    await settle();
    // Up again, but dropped before it was stable: the next wait is longer.
    w.clients[2]?.drop();
    expect(w.timers.next()).toBe(RECONNECT_BASE_MS * 2);
    await settle();
    w.timers.armed
      .filter((t) => !t.cleared && t.ms === STABLE_MS)
      .at(-1)
      ?.fire();
    w.clients[3]?.drop();
    expect(w.timers.next()).toBe(RECONNECT_BASE_MS);
  });

  test('a subscription that cannot be made on a live connection ends that connection', async () => {
    const w = world([]);
    await settle();
    const client = w.clients[1]!;
    client.subscribe = (): Promise<void> => Promise.reject(new Error('subscribe refused'));
    w.link.subscribe('late', () => undefined);
    await settle();
    expect(w.link.subscribed()).toBe(false);
    expect(client.closed).toBe(true);
  });
});
