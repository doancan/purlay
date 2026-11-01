/**
 * The liveness sweep (`liveness.ts`): a session removed by the database itself — the recovery command,
 * an operator's SQL — ends the sockets it held within a tick, with the frame and the close code every
 * other end of a session uses; a live one is untouched; all open sockets are asked about in ONE query
 * per tick (a batch of at most 1000); a failing query closes nothing and is tried again; the timer is
 * cleared at shutdown.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { CLOSE_CODES, ServerFrame as ServerFrameSchema, type ServerFrame } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { systemClock } from '../platform/clock';
import { createLogger } from '../platform/logging';
import { testConfig, testDependencies } from '../testing/doubles';
import { aSession, aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { aUserRow } from '../testing/users';
import type { Timers } from './hub';
import { startLivenessSweep, SWEEP_BATCH_MAX } from './liveness';
import { NO_SESSION_LIFETIME, type SessionLifetime } from '../modules/auth/session-lifetime';

const origin = 'https://purlay.test';

/** Timers the test fires by hand; `pending` is what is scheduled now. */
const fakeTimers = (): {
  readonly timers: Timers;
  readonly fire: () => void;
  readonly pending: () => number;
  readonly cleared: () => number;
} => {
  const waiting = new Map<number, () => void>();
  let next = 0;
  let cleared = 0;
  return {
    timers: {
      set: (callback): number => {
        next += 1;
        waiting.set(next, callback);
        return next;
      },
      clear: (handle): void => {
        if (typeof handle === 'number' && waiting.delete(handle)) cleared += 1;
      },
    },
    fire: (): void => {
      const first = [...waiting][0];
      if (first === undefined) throw new Error('nothing is scheduled');
      waiting.delete(first[0]);
      first[1]();
    },
    pending: () => waiting.size,
    cleared: () => cleared,
  };
};

const until = async (done: () => boolean, what: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
};

let cloned: ClonedDatabase;
let node: HttpApplication;
let port = 0;
const sweepTimers = fakeTimers();

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  node = createApp(
    testDependencies({
      database: cloned.db,
      clock: systemClock,
      config: testConfig({ APP_URL: origin }),
      liveness: { timers: sweepTimers.timers, intervalMs: 30_000 },
    }),
  );
  port = node.listen(0);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await node.stop(true);
  await cloned.drop();
}, DROP_HOOK_MS);

interface Client {
  readonly frames: ServerFrame[];
  readonly ended: Promise<number>;
  readonly closed: () => boolean;
}

const connect = async (cookie: string): Promise<Client> => {
  const socket = new WebSocket(`ws://localhost:${String(port)}/ws`, {
    headers: { cookie, origin },
  } as unknown as string[]);
  let closed = false;
  const ended = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      closed = true;
      resolve(event.code);
    });
  });
  const frames: ServerFrame[] = [];
  socket.addEventListener('message', (event) => {
    const received: unknown = JSON.parse(String(event.data));
    if (Value.Check(ServerFrameSchema, received)) frames.push(received);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket did not open'));
    });
  });
  // The hub resolves identity after the open: give it the moment it needs to know this session.
  await Bun.sleep(150);
  return { frames, ended, closed: () => closed };
};

/** One tick, by hand, and the sweep's next one scheduled again. */
const tick = async (): Promise<void> => {
  sweepTimers.fire();
  await until(() => sweepTimers.pending() === 1, 'the sweep to schedule its next tick');
};

const aUser = async (name: string): Promise<SignedInUser> =>
  await aSignedInUser(cloned.db, systemClock, name);

describe('integration: the liveness sweep', () => {
  test('a session deleted in SQL closes its socket within one tick, told why; a live session is untouched', async () => {
    const gone = await aUser('sweep-gone');
    const kept = await aUser('sweep-kept');
    const goneSocket = await connect(gone.cookie);
    const keptSocket = await connect(kept.cookie);

    await tick();
    expect([goneSocket.closed(), keptSocket.closed()]).toEqual([false, false]);

    await cloned.db.deleteFrom('sessions').where('id', '=', gone.sessionId).execute();
    await tick();
    expect(await goneSocket.ended).toBe(CLOSE_CODES.SESSION_ENDED);
    expect(goneSocket.frames.map((frame) => frame.event)).toContain('SESSION_ENDED');
    expect(goneSocket.frames.find((frame) => frame.event === 'SESSION_ENDED')).toMatchObject({
      data: { reason: 'signed-out' },
    });
    expect(keptSocket.closed()).toBe(false);
    expect(keptSocket.frames.map((frame) => frame.event)).not.toContain('SESSION_ENDED');
  });

  test('a session whose time has passed, or whose account was erased, is ended too', async () => {
    const lapsed = await aUser('sweep-lapsed');
    const erased = await aUser('sweep-erased');
    const lapsedSocket = await connect(lapsed.cookie);
    const erasedSocket = await connect(erased.cookie);
    await cloned.db
      .updateTable('sessions')
      .set({ expires_at: new Date(Date.now() - 1_000) })
      .where('id', '=', lapsed.sessionId)
      .execute();
    await cloned.db
      .updateTable('users')
      .set({ deleted_at: new Date() })
      .where('id', '=', erased.userId)
      .execute();
    await tick();
    expect(await lapsedSocket.ended).toBe(CLOSE_CODES.SESSION_ENDED);
    expect(await erasedSocket.ended).toBe(CLOSE_CODES.SESSION_ENDED);
    expect(lapsedSocket.frames.find((frame) => frame.event === 'SESSION_ENDED')).toMatchObject({
      data: { reason: 'expired' },
    });
    expect(erasedSocket.frames.find((frame) => frame.event === 'SESSION_ENDED')).toMatchObject({
      data: { reason: 'account-deleted' },
    });
  });

  test('shutdown clears the timer, and none is left to keep the process alive', async () => {
    const before = sweepTimers.cleared();
    await node.drain();
    expect(sweepTimers.cleared()).toBe(before + 1);
    expect(sweepTimers.pending()).toBe(0);
  });
});

/** A database whose queries are counted, and which can be made to fail. */
const counting = (): {
  readonly db: ClonedDatabase['db'];
  readonly queries: () => number;
  readonly failNext: () => void;
} => {
  let count = 0;
  let failing = false;
  return {
    db: cloned.db.withPlugin({
      transformQuery: (args) => {
        count += 1;
        if (failing) {
          failing = false;
          throw new Error('the database is down');
        }
        return args.node;
      },
      transformResult: async (args) => await Promise.resolve(args.result),
    }),
    queries: () => count,
    failNext: (): void => {
      failing = true;
    },
  };
};

const silent = createLogger({ level: 'silent' });

describe('integration: the liveness sweep, one query for all', () => {
  const sessionsOf = (count: number): { socketId: string; sessionId: string }[] =>
    Array.from({ length: count }, () => ({
      socketId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
    }));

  test('a thousand sockets are one query per tick; more are one per thousand', async () => {
    for (const [sockets, queries] of [
      [1000, 1],
      [2500, 3],
      [0, 0],
    ] as const) {
      const database = counting();
      const ended: string[] = [];
      const timers = fakeTimers();
      const sweep = startLivenessSweep({
        database: database.db,
        clock: systemClock,
        log: silent,
        timers: timers.timers,
        source: {
          sessions: () => sessionsOf(sockets),
          lifetime: () => NO_SESSION_LIFETIME,
          end: (socketId) => {
            ended.push(socketId);
          },
        },
      });
      await sweep.tick();
      expect([sockets, database.queries()]).toEqual([sockets, queries]);
      // Rows that do not exist are sessions that are gone: every one of them is ended.
      expect(ended).toHaveLength(sockets);
      sweep.stop();
    }
    expect(SWEEP_BATCH_MAX).toBe(1000);
  });

  test('no socket, no timer: none is scheduled until one opens, and none is kept once all have gone', async () => {
    const timers = fakeTimers();
    let open = sessionsOf(2);
    const sweep = startLivenessSweep({
      database: counting().db,
      clock: systemClock,
      log: silent,
      timers: timers.timers,
      source: {
        sessions: () => open,
        lifetime: () => NO_SESSION_LIFETIME,
        end: () => undefined,
      },
    });
    expect(timers.pending()).toBe(0);
    sweep.arm();
    sweep.arm();
    expect(timers.pending()).toBe(1);
    timers.fire();
    await until(() => timers.pending() === 1, 'the next tick while sockets are open');
    open = [];
    timers.fire();
    await Bun.sleep(100);
    expect(timers.pending()).toBe(0);
    sweep.stop();
  });

  test('a query that fails closes nothing, is logged, and is tried again at the next tick', async () => {
    const database = counting();
    const lines: string[] = [];
    const ended: string[] = [];
    const timers = fakeTimers();
    const sweep = startLivenessSweep({
      database: database.db,
      clock: systemClock,
      log: createLogger({
        level: 'debug',
        write: (line) => {
          lines.push(line);
        },
      }),
      timers: timers.timers,
      source: {
        sessions: () => sessionsOf(3),
        lifetime: () => NO_SESSION_LIFETIME,
        end: (socketId) => {
          ended.push(socketId);
        },
      },
    });
    sweep.arm();
    database.failNext();
    timers.fire();
    await until(() => timers.pending() === 1, 'the next tick to be scheduled');
    expect(ended).toEqual([]);
    expect(lines.join('\n')).toContain('liveness sweep failed');
    timers.fire();
    await until(() => ended.length === 3, 'the next tick to run');
    sweep.stop();
    expect(timers.pending()).toBe(0);
  });
});

describe('integration: the liveness sweep and the server’s session lifetime (D-244)', () => {
  const HOUR = 60 * 60 * 1000;
  const IDLE: SessionLifetime = { sessionIdleTimeoutHours: 8, sessionMaxAgeDays: null };
  const ago = (ms: number): Date => new Date(Date.now() - ms);
  const aLiveSession = async (
    db: Executor,
    name: string,
  ): Promise<{ readonly sessionId: string }> => {
    const user = await aUserRow(db, name);
    return { sessionId: (await aSession(db, systemClock, user.userId)).sessionId };
  };
  const travel = async (
    db: Executor,
    sessionId: string,
    times: { readonly lastUsedAt: Date },
  ): Promise<void> => {
    await db
      .updateTable('sessions')
      .set({ last_used_at: times.lastUsedAt })
      .where('id', '=', sessionId)
      .execute();
  };

  test('an open socket whose session lapsed is ended at the sweep’s next check, as expired; one in use is not', async () => {
    const db = cloned.db;
    const unused = await aLiveSession(db, 'sweep-unused');
    const used = await aLiveSession(db, 'sweep-used');
    await travel(db, unused.sessionId, { lastUsedAt: ago(9 * HOUR) });
    await travel(db, used.sessionId, { lastUsedAt: ago(HOUR) });
    let lifetime = NO_SESSION_LIFETIME;
    const ended: [string, ServerFrame][] = [];
    const sweep = startLivenessSweep({
      database: db,
      clock: systemClock,
      log: silent,
      source: {
        sessions: () => [
          { socketId: 'socket-unused', sessionId: unused.sessionId },
          { socketId: 'socket-used', sessionId: used.sessionId },
        ],
        end: (socketId, frame) => {
          ended.push([socketId, frame]);
        },
        lifetime: () => lifetime,
      },
    });
    // Off: nothing is ended — the control for what follows.
    await sweep.tick();
    expect(ended).toEqual([]);
    // Turned on with both sockets open: read at the next check.
    lifetime = IDLE;
    await sweep.tick();
    expect(ended.map(([socketId, frame]) => [socketId, frame.event, frame.data])).toEqual([
      ['socket-unused', 'SESSION_ENDED', { reason: 'expired' }],
    ]);
    sweep.stop();
  });
});
