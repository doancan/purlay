/**
 * A drain against a running server (#220): the request in flight finishes, the
 * socket is told to come back, readiness says no, and nothing new is accepted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { CLOSE_CODES, messageId } from '@purlay/types';
import type { GitHubEmail } from '../modules/auth/github';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { aGitHubAccount, testConfig, testDependencies } from '../testing/doubles';
import { aSignedInUser } from '../testing/signed-in';
import { fixedClock } from '../platform/clock';

const origin = 'https://purlay.test';
const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));
let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

/**
 * A thing that waits until it is told to go, and says when it has started waiting.
 *
 * What these tests hold in flight is held by this and not by a sleep: a sleep is a
 * guess about how soon the other side gets there, and a loaded machine makes it a
 * wrong one — the drain then begins before the work it is meant to find, and the
 * test passes or fails on the scheduler instead of the drain.
 */
interface Gate {
  readonly reached: Promise<void>;
  readonly wait: () => Promise<void>;
  readonly release: () => void;
}

const aGate = (): Gate => {
  const reached = Promise.withResolvers<undefined>();
  const released = Promise.withResolvers<undefined>();
  return {
    reached: reached.promise,
    wait: async (): Promise<void> => {
      reached.resolve(undefined);
      await released.promise;
    },
    release: (): void => {
      released.resolve(undefined);
    },
  };
};

/** GitHub, held up until the test lets it go: a sign-in through it is a request still in flight. */
const aSlowGitHub = (gate: Gate): ReturnType<typeof aGitHubAccount> => {
  const fast = aGitHubAccount({ id: 9001, login: 'slow-signin', name: null, avatarUrl: null }, [
    { email: 'slow-signin@example.test', primary: true, verified: true } satisfies GitHubEmail,
  ]);
  return {
    ...fast,
    exchangeCode: async (code: string): Promise<string> => {
      await gate.wait();
      return await fast.exchangeCode(code);
    },
  };
};

describe('integration: draining for shutdown', () => {
  test('finishes what is in flight, tells sockets to reconnect, and takes nothing new', async () => {
    const github = aGate();
    const app: HttpApplication = createApp(
      testDependencies({
        database: cloned.db,
        clock,
        github: aSlowGitHub(github),
        config: testConfig({ APP_URL: origin }),
      }),
    );
    const server = `http://localhost:${String(app.listen(0))}`;

    const user = await aSignedInUser(cloned.db, clock, 'drain');
    const socket = new WebSocket(`${server.replace('http', 'ws')}/ws`, {
      headers: { cookie: user.cookie, origin },
    } as unknown as string[]);
    const closed = new Promise<number>((resolve) => {
      socket.addEventListener('close', (event) => {
        resolve(event.code);
      });
    });
    await new Promise<void>((resolve) => {
      socket.addEventListener('open', () => {
        resolve();
      });
    });

    // A sign-in, started and still waiting on GitHub when the drain begins.
    const started = await fetch(`${server}/auth/github`, { redirect: 'manual' });
    const state = new URL(started.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const stateCookie = (started.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const inFlight = fetch(`${server}/auth/github/callback?code=a-valid-code&state=${state}`, {
      headers: { cookie: stateCookie },
      redirect: 'manual',
    });
    await github.reached;

    const drained = app.drain();
    expect(await closed).toBe(CLOSE_CODES.RESTARTING);
    // The drain is waiting for the request: it has not finished while GitHub is held.
    expect(
      await Promise.race([drained.then(() => 'drained'), Bun.sleep(100).then(() => 'waiting')]),
    ).toBe('waiting');
    github.release();
    const finished = await inFlight;
    expect(finished.status).toBe(302);
    expect(finished.headers.get('location')).toBe(origin);
    await drained;

    const readiness = await app.handle(new Request(`${origin}/health/ready`));
    expect(readiness.status).toBe(503);
    expect(
      await fetch(`${server}/health`).then(
        () => 'accepted',
        () => 'refused',
      ),
    ).toBe('refused');
  });

  /**
   * The pool closes right after the drain returns. A frame still being handled
   * would then read from a pool pulled out from under it, so the drain waits for
   * it — the frame's read here is held up by the database, not by a sleep in the
   * code under test.
   */
  test('waits for a frame being handled, so the pool is not closed under it', async () => {
    let slow = false;
    let queryFinished = false;
    const query = aGate();
    const database = cloned.db.withPlugin({
      transformQuery: (args) => args.node,
      transformResult: async (args) => {
        if (slow) {
          await query.wait();
          queryFinished = true;
        }
        return args.result;
      },
    });
    const app = createApp(
      testDependencies({ database, clock, config: testConfig({ APP_URL: origin }) }),
    );
    const server = `http://localhost:${String(app.listen(0))}`;
    const user = await aSignedInUser(cloned.db, clock, 'drain-frame');
    const socket = new WebSocket(`${server.replace('http', 'ws')}/ws`, {
      headers: { cookie: user.cookie, origin },
    } as unknown as string[]);
    await new Promise<void>((resolve) => {
      socket.addEventListener('open', () => {
        resolve();
      });
    });

    slow = true;
    socket.send(
      JSON.stringify({
        id: messageId(clock.now()),
        op: 'SUBSCRIBE',
        payload: {
          channels: [{ channelId: '00000000-0000-4000-8000-000000000001', afterMessageId: null }],
        },
      }),
    );
    // Until the handler has reached the database, there is nothing in flight to wait for.
    await query.reached;
    expect(queryFinished).toBe(false);

    const drained = app.drain();
    // The drain is waiting for the frame: it has not finished while the read is held.
    expect(
      await Promise.race([drained.then(() => 'drained'), Bun.sleep(100).then(() => 'waiting')]),
    ).toBe('waiting');
    expect(queryFinished).toBe(false);
    query.release();
    await drained;
    expect(queryFinished).toBe(true);
  });
});
