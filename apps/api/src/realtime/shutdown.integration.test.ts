/**
 * A drain against a running server (#220): the request in flight finishes, the
 * socket is told to come back, readiness says no, and nothing new is accepted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { CLOSE_CODES, messageId } from '@purlay/types';
import type { GitHubEmail } from '../modules/auth/github';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { aGitHubAccount, testConfig, testDependencies } from '../ingress/http/testing';
import { aSignedInUser } from '../ingress/http/fixtures';
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

/** GitHub, taking its time: a sign-in through it is a request still in flight. */
const aSlowGitHub = (): ReturnType<typeof aGitHubAccount> => {
  const fast = aGitHubAccount({ id: 9001, login: 'slow-signin', name: null, avatarUrl: null }, [
    { email: 'slow-signin@example.test', primary: true, verified: true } satisfies GitHubEmail,
  ]);
  return {
    ...fast,
    exchangeCode: async (code: string): Promise<string> => {
      await Bun.sleep(300);
      return await fast.exchangeCode(code);
    },
  };
};

describe('integration: draining for shutdown', () => {
  test('finishes what is in flight, tells sockets to reconnect, and takes nothing new', async () => {
    const app: HttpApplication = createApp(
      testDependencies({
        database: cloned.db,
        clock,
        github: aSlowGitHub(),
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
    await Bun.sleep(50);

    const drained = app.drain();
    expect(await closed).toBe(CLOSE_CODES.RESTARTING);
    expect((await inFlight).status).toBe(302);
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
    const database = cloned.db.withPlugin({
      transformQuery: (args) => args.node,
      transformResult: async (args) => {
        if (slow) {
          await Bun.sleep(300);
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
    const deadline = Date.now() + 5_000;
    while (app.held().connections === 0 && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(100);
    expect(queryFinished).toBe(false);

    await app.drain();
    expect(queryFinished).toBe(true);
  });
});
