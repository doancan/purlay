/**
 * The one connection to a shared Redis, for the cloud's several nodes (D-201, D-25).
 *
 * **Opened only when `REDIS_URL` is set**, by `index.ts` and nothing else: a self-hosted instance never
 * reaches this file's `connectRedis`, so it opens no socket and starts no timer (D-7). Bun's own client is
 * used — it has commands, scripts and pub/sub — so no dependency is added (`CONTRIBUTING.md` §1.12).
 *
 * **Two connections, because a subscribed connection can run nothing else:** one for commands, one for the
 * subscription. Each is owned here rather than left to the client's own reconnection, which was measured not
 * to re-subscribe after a drop (a publish after a Redis restart reached nobody) and which gives up after
 * twenty tries. So a lost connection is replaced by a **new** client after a wait that doubles up to
 * `RECONNECT_MAX_MS`, forever, and every channel is subscribed again on it. Whoever listens is told that a
 * connection came back (`onResubscribed`): frames published while it was down were not heard.
 *
 * **A command never waits for a connection.** Offline, it fails at once; connected, it fails after
 * `COMMAND_TIMEOUT_MS`. What each caller does about that is its own decision (D-201): a limiter falls back to
 * a node-local bucket, the bus delivers on this node, presence is read from the node. Nothing here throws
 * outside a promise the caller holds, and no failure is left unhandled.
 *
 * The address holds a password, so it is never logged: a line says that Redis was lost, and why, never where.
 */
import type { Logger } from './logging';

/** What this file asks of a client: the part of Bun's `RedisClient` it uses, so a test can stand one in. */
export interface RedisClientLike {
  readonly connect: () => Promise<void>;
  readonly close: () => void;
  readonly send: (command: string, args: readonly string[]) => Promise<unknown>;
  readonly subscribe: (channel: string, listener: (message: string) => void) => Promise<void>;
  /** Called once when this client's connection is lost or closed. */
  readonly onClose: (handler: (error: Error) => void) => void;
}

export interface RedisTimers {
  readonly set: (callback: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

const systemTimers: RedisTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** How long a command may take before it is given up on. */
export const COMMAND_TIMEOUT_MS = 2_000;
/** The first wait before trying again, and the longest. */
export const RECONNECT_BASE_MS = 250;
export const RECONNECT_MAX_MS = 15_000;

export interface RedisLink {
  /** Runs one command. Rejects when not connected, on an error reply, and after `COMMAND_TIMEOUT_MS`. */
  readonly send: (command: string, args: readonly string[]) => Promise<unknown>;
  /** Runs a Lua script atomically: `keys` first, then `args`. */
  readonly script: (
    source: string,
    keys: readonly string[],
    args: readonly string[],
  ) => Promise<unknown>;
  /** Listens on a channel, and again after every reconnection. Call before or after the connection is up. */
  readonly subscribe: (channel: string, listener: (message: string) => void) => void;
  /** Told each time the subscription is made again after a loss: what was published meanwhile was missed. */
  readonly onResubscribed: (listener: () => void) => void;
  /** Whether both connections are up now. */
  readonly connected: () => boolean;
  /** Whether the subscription is up: frames published through Redis reach this process only while it is. */
  readonly subscribed: () => boolean;
  /** A reason this node should not take traffic: it has never reached Redis. Undefined once it has. */
  readonly problem: () => string | undefined;
  /** Stops reconnecting and closes both connections. Never throws; safe to call twice. */
  readonly close: () => void;
}

export interface RedisOptions {
  readonly create: () => RedisClientLike;
  readonly log: Logger;
  readonly timers?: RedisTimers;
  /** 0..1, for the wait before a retry; a test passes a constant. */
  readonly jitter?: () => number;
}

interface Slot {
  client: RedisClientLike | undefined;
  up: boolean;
  everUp: boolean;
  attempts: number;
  timer: unknown;
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error';

export const connectRedis = ({
  create,
  log,
  timers = systemTimers,
  jitter = Math.random,
}: RedisOptions): RedisLink => {
  let closed = false;
  const channels = new Map<string, (message: string) => void>();
  const resubscribed = new Set<() => void>();
  const commands: Slot = { client: undefined, up: false, everUp: false, attempts: 0, timer: null };
  const listening: Slot = { client: undefined, up: false, everUp: false, attempts: 0, timer: null };

  const connect = (role: 'commands' | 'subscription', slot: Slot): void => {
    if (closed) return;
    const client = create();
    slot.client = client;
    let lost = false;
    const lose = (reason: unknown): void => {
      if (lost) return;
      lost = true;
      const wasUp = slot.up;
      slot.up = false;
      slot.client = undefined;
      try {
        client.close();
      } catch {
        // Already closed: nothing left to release.
      }
      if (closed) return;
      const wait = Math.round(
        Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** slot.attempts) * (0.5 + jitter() / 2),
      );
      slot.attempts += 1;
      // Said when a working connection is lost and at the first failed attempt, then quietly while it
      // stays down: a Redis that is away for an hour is not three hundred lines.
      (wasUp || slot.attempts === 1 ? log.warn : log.debug)('redis connection lost; reconnecting', {
        role,
        err: describe(reason),
        retryInMs: wait,
      });
      slot.timer = timers.set(() => {
        connect(role, slot);
      }, wait);
    };
    client.onClose(lose);
    const opening = async (): Promise<void> => {
      await client.connect();
      if (role === 'subscription') {
        for (const [channel, listener] of channels) await client.subscribe(channel, listener);
      }
    };
    opening().then(
      () => {
        if (closed || lost) {
          if (!lost) client.close();
          return;
        }
        const again = slot.everUp;
        slot.up = true;
        slot.everUp = true;
        slot.attempts = 0;
        if (again) {
          log.info('redis connection restored', { role });
          if (role === 'subscription') {
            for (const listener of resubscribed) {
              try {
                listener();
              } catch (error) {
                log.error('a listener of the resubscription failed', { err: error });
              }
            }
          }
        }
      },
      (error: unknown) => {
        lose(error);
      },
    );
  };

  connect('commands', commands);
  connect('subscription', listening);

  const send = async (command: string, args: readonly string[]): Promise<unknown> => {
    const client = commands.client;
    if (!commands.up || client === undefined) throw new Error('redis is not connected');
    let timer: unknown;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = timers.set(() => {
        reject(new Error(`redis ${command} timed out`));
      }, COMMAND_TIMEOUT_MS);
    });
    try {
      return await Promise.race([client.send(command, args), timeout]);
    } finally {
      timers.clear(timer);
    }
  };

  return {
    send,
    script: async (source, keys, args) =>
      await send('EVAL', [source, String(keys.length), ...keys, ...args]),
    subscribe: (channel, listener): void => {
      channels.set(channel, listener);
      const client = listening.client;
      if (listening.up && client !== undefined) {
        client.subscribe(channel, listener).catch((error: unknown) => {
          log.error('redis subscribe failed', { err: describe(error) });
        });
      }
    },
    onResubscribed: (listener): void => {
      resubscribed.add(listener);
    },
    connected: () => commands.up && listening.up,
    subscribed: () => listening.up,
    problem: () =>
      commands.everUp && listening.everUp ? undefined : 'redis has not been reached since start',
    close: (): void => {
      if (closed) return;
      closed = true;
      for (const slot of [commands, listening]) {
        timers.clear(slot.timer);
        slot.up = false;
        try {
          slot.client?.close();
        } catch {
          // Nothing left to release.
        }
        slot.client = undefined;
      }
    },
  };
};

/** The real client: Bun's, with its own reconnection off — this file owns it, and says why above. */
export const bunRedisClient = (url: string): RedisClientLike => {
  const client = new Bun.RedisClient(url, {
    autoReconnect: false,
    enableOfflineQueue: false,
    connectionTimeout: 5_000,
    maxRetries: 0,
  });
  return {
    connect: async (): Promise<void> => {
      await client.connect();
    },
    close: (): void => {
      client.close();
    },
    send: async (command, args): Promise<unknown> => {
      const reply: unknown = await client.send(command, [...args]);
      return reply;
    },
    subscribe: async (channel, listener): Promise<void> => {
      await client.subscribe(channel, listener);
    },
    onClose: (handler): void => {
      client.onclose = (error: Error): void => {
        handler(error);
      };
    },
  };
};
