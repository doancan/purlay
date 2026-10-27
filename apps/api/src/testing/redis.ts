/**
 * Stand-ins for the Redis link, and the way an integration test reaches a real one (D-201).
 */
import { connectRedis, bunRedisClient, type RedisLink } from '../platform/redis';
import { createLogger } from '../platform/logging';

/** A link that answers from what a test gives it. Scripts are answered by `onScript`, commands by `onSend`. */
export interface FakeLink extends RedisLink {
  readonly scripts: { source: string; keys: readonly string[]; args: readonly string[] }[];
  readonly sent: { command: string; args: readonly string[] }[];
  /** Plays Redis's `PUBLISH` to every listener of the channel. */
  readonly deliver: (channel: string, message: string) => void;
  /** What the link says now. */
  readonly state: { connected: boolean; subscribed: boolean };
  /** What the next scripts and commands do: answer, or throw. Default: reject as offline. */
  behaviour: {
    script: (keys: readonly string[], args: readonly string[]) => unknown;
    send: (command: string, args: readonly string[]) => unknown;
  };
  /** Fire the callbacks `onResubscribed` was given. */
  readonly resubscribe: () => void;
}

export const aFakeLink = (): FakeLink => {
  const listeners = new Map<string, ((message: string) => void)[]>();
  const resubscribed: (() => void)[] = [];
  const state = { connected: true, subscribed: true };
  const link: FakeLink = {
    scripts: [],
    sent: [],
    state,
    behaviour: {
      script: () => {
        throw new Error('redis is not connected');
      },
      send: () => {
        throw new Error('redis is not connected');
      },
    },
    send: async (command, args): Promise<unknown> => {
      link.sent.push({ command, args });
      await Promise.resolve();
      return link.behaviour.send(command, args);
    },
    script: async (source, keys, args): Promise<unknown> => {
      link.scripts.push({ source, keys, args });
      await Promise.resolve();
      return link.behaviour.script(keys, args);
    },
    subscribe: (channel, listener): void => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener]);
    },
    onResubscribed: (listener): void => {
      resubscribed.push(listener);
    },
    connected: () => state.connected,
    subscribed: () => state.subscribed,
    problem: () => undefined,
    close: (): void => undefined,
    deliver: (channel, message): void => {
      for (const listener of listeners.get(channel) ?? []) listener(message);
    },
    resubscribe: (): void => {
      for (const listener of resubscribed) listener();
    },
  };
  return link;
};

/**
 * The address of the Redis the tests may use, from `.env.test` or the pipeline. **Refuses rather than
 * skips** — a suite that quietly runs nothing looks exactly like one where everything passed — but
 * `bun run test:all` leaves these files out, said loudly, where no Redis is reachable (`scripts/test-all.ts`).
 */
export const redisUrlForTests = (): string => {
  const url = process.env['REDIS_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'REDIS_URL is not set: the Redis integration tests need one (`bun run db:up:redis`, then REDIS_URL in .env.test)',
    );
  }
  return url;
};

/** A real link to that Redis, waited for until it is connected. */
export const aRealLink = async (url: string = redisUrlForTests()): Promise<RedisLink> => {
  const link = connectRedis({
    create: () => bunRedisClient(url),
    log: createLogger({ level: 'silent' }),
  });
  const started = performance.now();
  while (!link.connected()) {
    if (performance.now() - started > 5_000) {
      link.close();
      throw new Error('the test Redis did not answer within five seconds');
    }
    await Bun.sleep(10);
  }
  return link;
};

/** What a promise was refused with, as text, or that it was not refused: for `expect(…).toContain(…)`. */
export const refusedWith = async (attempt: Promise<unknown>): Promise<string> =>
  await attempt.then(
    () => 'was not refused',
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );

/** A TCP proxy in front of the test Redis that can cut every connection through it, and keeps listening. */
export interface DroppableProxy {
  /** The address to give a link, in place of Redis's own. */
  readonly url: string;
  /** Cuts every connection now. New ones are accepted again at once, like a Redis that restarted. */
  readonly drop: () => void;
  /** Stops accepting and cuts what is open. */
  readonly stop: () => void;
}

export const aDroppableProxy = async (target: string): Promise<DroppableProxy> => {
  const { createConnection, createServer } = await import('node:net');
  const to = new URL(target);
  const open = new Set<{ destroy: () => void }>();
  const server = createServer((client) => {
    const upstream = createConnection({ host: to.hostname, port: Number(to.port || 6379) });
    open.add(client);
    open.add(upstream);
    client.pipe(upstream);
    upstream.pipe(client);
    for (const socket of [client, upstream]) {
      socket.on('error', () => {
        client.destroy();
        upstream.destroy();
      });
      socket.on('close', () => {
        client.destroy();
        upstream.destroy();
        open.delete(client);
        open.delete(upstream);
      });
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the proxy has no port');
  const drop = (): void => {
    for (const socket of [...open]) socket.destroy();
  };
  return {
    url: `redis://127.0.0.1:${String(address.port)}`,
    drop,
    stop: (): void => {
      drop();
      server.close();
    },
  };
};
