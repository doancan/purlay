/**
 * The reporter cannot be held hostage, and does not leak the host (#231, D-96 amended).
 *
 * A second-round audit pointed the reporter at a collector that accepts connections and
 * never answers: 25 failing requests produced 10 deliveries and then no error was ever
 * reported again until restart, nothing said reports were being dropped, and SIGTERM ran
 * to the full ten-second deadline. These tests use a real HTTP server for that, and the
 * same `fetch` adapter the process uses.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { Clock } from './clock';
import {
  createErrorTracker,
  fetchDelivery,
  scrubPaths,
  type Delivery,
  type ErrorTracker,
} from './error-tracking';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const servers: { stop: (closeActiveConnections?: boolean) => unknown }[] = [];
afterAll(() => {
  for (const server of servers) void server.stop(true);
});

/** A collector that accepts the connection, reads the request, and never answers. */
const silentCollector = (): { dsn: string } => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => undefined),
  });
  servers.push(server);
  return { dsn: `http://key@127.0.0.1:${String(server.port)}/1` };
};

/**
 * Waits for the condition, by the clock rather than a count of tries: under the full suite's load two
 * requests took longer than the two seconds a hundred tries had, and the test failed waiting, not
 * asserting. Four seconds, inside the ten each such test is given.
 */
const UNTIL_MS = 4_000;
/** The bound on a test that waits with `until`: the wait, and room for what follows it. */
const WAITING_TEST_MS = 10_000;
const until = async (condition: () => boolean, what: string): Promise<void> => {
  const deadline = performance.now() + UNTIL_MS;
  while (performance.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(20);
  }
  if (!condition()) throw new Error(`gave up waiting for ${what}`);
};

/**
 * The process's own delivery, counting what the reporter sends. What is asserted is what the reporter
 * did — a request made — not that the loopback server ran its handler before the request's timeout
 * aborted it: in one process under load the handler can be scheduled after the abort, and a request
 * that was sent then never "arrives" (#632, reproduced 1 run in 48 beside CPU load).
 */
const counted = (): { send: Delivery; sent: () => number } => {
  let sent = 0;
  const send: Delivery = (url, init) => {
    sent += 1;
    return fetchDelivery(url, init);
  };
  return { send, sent: (): number => sent };
};

const movingClock = (): { clock: Clock; advance: (ms: number) => void } => {
  let at = NOW.getTime();
  return {
    clock: { now: (): Date => new Date(at) },
    advance: (ms): void => {
      at += ms;
    },
  };
};

const report = (tracker: ErrorTracker, label: string): void => {
  tracker.capture({ message: label, fields: {} });
};

describe('an urgent report (#634)', () => {
  test(
    'is sent when the ordinary ones fill every slot: a crashing process has one thing left to say',
    async () => {
      const collector = silentCollector();
      const delivery = counted();
      const tracker = createErrorTracker({
        dsn: collector.dsn,
        environment: 'development',
        clock: { now: () => NOW },
        send: delivery.send,
        maxInFlight: 2,
        timeoutMs: 5_000,
      });
      for (let i = 0; i < 4; i += 1) report(tracker, `ordinary ${String(i)}`);
      await until(() => delivery.sent() === 2, 'the two ordinary slots to fill');
      expect(tracker.dropped()).toBe(2);
      tracker.capture({ message: 'an error escaped every handler; exiting', fields: {} }, 'urgent');
      await until(() => delivery.sent() === 3, 'the urgent report to be sent');
      // One reserved slot, not a way around the bound: a second urgent report is dropped.
      tracker.capture({ message: 'and another', fields: {} }, 'urgent');
      expect(tracker.dropped()).toBe(3);
    },
    WAITING_TEST_MS,
  );
});

describe('a collector that never answers', () => {
  test(
    'does not stop later errors being reported: each request is given up on after the timeout',
    async () => {
      const collector = silentCollector();
      const delivery = counted();
      const failures: unknown[] = [];
      const tracker = createErrorTracker({
        dsn: collector.dsn,
        environment: 'development',
        clock: { now: () => NOW },
        send: delivery.send,
        maxInFlight: 3,
        timeoutMs: 150,
        onFailure: (error) => failures.push(error),
      });

      for (let i = 0; i < 8; i += 1) report(tracker, `first burst ${String(i)}`);
      await until(() => delivery.sent() === 3, 'the first three requests to be sent');
      expect(tracker.dropped()).toBe(5);

      // Without a timeout the three slots stay taken for ever and nothing below is ever sent.
      await until(() => failures.length === 3, 'the three requests to time out');
      for (let i = 0; i < 3; i += 1) report(tracker, `second burst ${String(i)}`);
      await until(() => delivery.sent() === 6, 'the second burst to be sent');
      expect(delivery.sent()).toBe(6);
    },
    WAITING_TEST_MS,
  );

  test(
    'is not waited on at shutdown beyond a short bound, and what is left is abandoned',
    async () => {
      const collector = silentCollector();
      const delivery = counted();
      const failures: unknown[] = [];
      const tracker = createErrorTracker({
        dsn: collector.dsn,
        environment: 'development',
        clock: { now: () => NOW },
        send: delivery.send,
        timeoutMs: 60_000,
        onFailure: (error) => failures.push(error),
      });
      report(tracker, 'one');
      report(tracker, 'two');
      await until(() => delivery.sent() === 2, 'both requests to be sent');

      const started = performance.now();
      await tracker.flush(150);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeLessThan(1_500);
      // Abandoned means ended, not forgotten: the sockets are released.
      await until(() => failures.length === 2, 'the abandoned requests to be reported');
    },
    WAITING_TEST_MS,
  );
});

describe('a collector that redirects', () => {
  test('is not followed: a report goes to the host in the DSN and nowhere else', async () => {
    let reached = 0;
    const elsewhere = Bun.serve({
      port: 0,
      fetch: () => {
        reached += 1;
        return new Response('{}');
      },
    });
    servers.push(elsewhere);
    const redirector = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { Location: `http://127.0.0.1:${String(elsewhere.port)}/` },
        }),
    });
    servers.push(redirector);

    const failures: unknown[] = [];
    const tracker = createErrorTracker({
      dsn: `http://key@127.0.0.1:${String(redirector.port)}/1`,
      environment: 'development',
      clock: { now: () => NOW },
      send: fetchDelivery,
      onFailure: (error) => failures.push(error),
    });
    report(tracker, 'boom');
    await tracker.flush();
    expect(reached).toBe(0);
    expect(failures).toHaveLength(1);
  });
});

describe('dropped reports are said so, at most once a minute', () => {
  test('a burst is one notice with the total; a later drop, after the interval, is another', () => {
    const { clock, advance } = movingClock();
    const notices: number[] = [];
    const hang: Delivery = () => new Promise(() => undefined);
    const tracker = createErrorTracker({
      dsn: 'http://key@collector.example.test/1',
      environment: 'development',
      clock,
      send: hang,
      maxInFlight: 1,
      onDropped: (total) => notices.push(total),
    });

    report(tracker, 'sent');
    for (let i = 0; i < 100; i += 1) report(tracker, `dropped ${String(i)}`);
    expect(notices).toEqual([1]);

    advance(30_000);
    report(tracker, 'still inside the minute');
    expect(notices).toEqual([1]);

    advance(31_000);
    report(tracker, 'after the minute');
    expect(notices).toEqual([1, 102]);
    expect(tracker.dropped()).toBe(102);
  });
});

describe('what a report says about the host', () => {
  test('absolute paths in a stack are made relative or shortened, and URLs are left alone', () => {
    const root = '/Users/dev/purlay';
    const text = [
      'TypeError: x',
      `    at handler (${root}/apps/api/src/ingress/http/app.ts:94:5)`,
      `    at query (${root}/node_modules/.bun/pg-pool@3.14.0+abc/node_modules/pg-pool/index.js:45:11)`,
      '    at run (/opt/runtime/lib/other.js:3:4)',
      "ENOENT: no such file or directory, open '/home/alice/secrets/key.pem'",
      'fetch https://api.example.test/v1/things failed',
    ].join('\n');
    const scrubbed = scrubPaths(text, root);

    expect(scrubbed).toContain('at handler (apps/api/src/ingress/http/app.ts:94:5)');
    expect(scrubbed).toContain('node_modules/pg-pool/index.js:45:11');
    expect(scrubbed).toContain('at run (…/other.js:3:4)');
    expect(scrubbed).toContain("open '…/key.pem'");
    expect(scrubbed).toContain('https://api.example.test/v1/things');
    for (const leaked of ['/Users/dev', '/home/alice', '/opt/runtime']) {
      expect(scrubbed).not.toContain(leaked);
    }
  });

  test('the event the tracker sends carries no host path, in the stack, the message or the fields', async () => {
    const bodies: string[] = [];
    const tracker = createErrorTracker({
      dsn: 'http://key@collector.example.test/1',
      environment: 'development',
      clock: { now: () => NOW },
      root: '/Users/dev/purlay',
      send: async (_url, init): Promise<{ readonly ok: boolean }> => {
        await Promise.resolve();
        bodies.push(init.body);
        return { ok: true };
      },
    });
    tracker.capture({
      message: 'request failed',
      fields: {
        err: {
          type: 'Error',
          message: "open '/home/alice/x.txt'",
          stack: 'Error\n    at f (/Users/dev/purlay/apps/api/src/a.ts:1:2)',
        },
        file: '/home/alice/y.txt',
        files: ['/home/alice/z.txt', 3, true, null],
        nested: { list: ['/home/alice/w.txt'] },
      },
    });
    await tracker.flush();
    expect(bodies).toHaveLength(1);
    for (const leaked of ['/Users/dev', '/home/alice']) expect(bodies[0]).not.toContain(leaked);
    expect(bodies[0]).toContain('apps/api/src/a.ts:1:2');
  });
});
