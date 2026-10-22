/**
 * Both doors resolve a session through the one seam (`sessionFromHeaders`, D-60, D-179): an HTTP
 * request and a socket upgrade carrying the same cookie name the same person, and once the session
 * has ended neither door lets it in — a new socket after *sign out everywhere* included.
 *
 * The functions behind each door, inside a transaction that is rolled back (D-46); then the running
 * server, on a database of its own, so the wiring is what is tested and not only what it calls.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  cloneIntegrationDatabase,
  withRollback,
  type ClonedDatabase,
} from '@purlay/db';
import type { MeResponse } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import type { AppError } from '../../platform/errors';
import { SESSION_COOKIE } from '../../platform/cookies';
import { createLogger } from '../../platform/logging';
import { revokeAllSessions } from '../../modules/auth/sessions';
import { admitSocket } from '../../realtime/upgrade';
import { createSocketHub } from '../../realtime/hub';
import { aSession, aSignedInUser, aTestAuth } from '../../testing/signed-in';
import { testConfig, testDependencies } from '../../testing/doubles';
import { createApp, type HttpApplication } from './app';
import { requireSession } from './session';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';

afterAll(async () => {
  await closeIntegrationDatabase();
});

describe('integration: the two doors, one seam', () => {
  test('resolves the same owner from an HTTP request and a socket upgrade', async () => {
    await withRollback(async (db) => {
      const auth = aTestAuth(db);
      const alice = await aSignedInUser(db, clock, 'seam-doors');
      const request = new Request(`${ORIGIN}/ws`, {
        headers: { cookie: alice.cookie, origin: ORIGIN },
      });
      const hub = createSocketHub(auth, clock, {
        log: createLogger({ level: 'silent' }),
        leave: () => undefined,
        listen: () => undefined,
        timers: { set: () => 0, clear: () => undefined },
      });

      expect(await requireSession(auth, request)).toEqual({
        userId: alice.userId,
        sessionId: alice.sessionId,
      });
      expect(await admitSocket({ auth, appUrl: ORIGIN }, request)).toEqual({
        userId: alice.userId,
      });
      expect(
        await hub.opened(
          's',
          { send: () => 1, buffered: () => 0, close: () => undefined },
          request,
        ),
      ).toMatchObject({ userId: alice.userId, sessionId: alice.sessionId });

      await revokeAllSessions(db, alice.userId);
      for (const door of [
        async (): Promise<unknown> => await requireSession(auth, request),
        async (): Promise<unknown> => await admitSocket({ auth, appUrl: ORIGIN }, request),
      ]) {
        const refusal = await door().catch((e: unknown) => e);
        expect((refusal as AppError).body.code).toBe('UNAUTHENTICATED');
      }
    });
  });
});

describe('integration: the two doors of a running server', () => {
  let cloned: ClonedDatabase;
  let app: HttpApplication;
  let server = '';

  beforeAll(async () => {
    cloned = await cloneIntegrationDatabase();
    app = createApp(
      testDependencies({ database: cloned.db, clock, config: testConfig({ APP_URL: ORIGIN }) }),
    );
    server = `http://localhost:${String(app.listen(0))}`;
  });

  afterAll(async () => {
    await app.stop(true);
    await cloned.drop();
  });

  const upgrade = async (cookie: string): Promise<Response> =>
    await fetch(`${server}/ws`, {
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        origin: ORIGIN,
        cookie,
      },
    });
  const me = async (cookie: string): Promise<Response> =>
    await app.handle(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }));

  test('name the same person from the same cookie', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'doors-same');
    const overHttp = await me(alice.cookie);
    expect(overHttp.status).toBe(200);
    expect(((await overHttp.json()) as MeResponse).user.id).toBe(alice.userId);
    expect((await upgrade(alice.cookie)).status).toBe(101);
  });

  test('rejects a new socket after sign out everywhere', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'doors-everywhere');
    const second = await aSession(cloned.db, clock, alice.userId);
    // The control: the same upgrade is switched while the session lives.
    expect((await upgrade(alice.cookie)).status).toBe(101);

    const out = await app.handle(
      new Request(`${ORIGIN}/auth/logout-all`, {
        method: 'POST',
        headers: { cookie: alice.cookie, origin: ORIGIN },
      }),
    );
    expect(out.status).toBe(204);
    for (const cookie of [alice.cookie, `${SESSION_COOKIE}=${second.token}`]) {
      const refused = await upgrade(cookie);
      expect(refused.status).toBe(401);
      // D-60: the same refusal a missing cookie gets.
      expect(await refused.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
      expect((await me(cookie)).status).toBe(401);
    }
    expect(
      await cloned.db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', alice.userId)
        .execute(),
    ).toEqual([]);
  });
});
