/**
 * A drain against a running server (#220): the request in flight finishes, the
 * socket is told to come back, readiness says no, and nothing new is accepted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { CLOSE_CODES } from '@purlay/types';
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
});
