/**
 * The server's session lifetime policy against a real database (D-244): a session unused past the idle timeout,
 * or older than the maximum age, answers as a signed-out one does on the next request and its row is gone; use
 * moves the idle end and nothing else does; off, every session lives as it did; and every door is held to it —
 * our routes and the socket's upgrade through `sessionFromHeaders`, the library's own routes, the device list, and
 * the native application's session. An open socket at its next check is `realtime/liveness.integration.test.ts`'s.
 *
 * The first part runs inside a rolled-back transaction (D-46). Two requests at the same instant, the library's
 * routes and the native handoff need connections of their own, so the second part runs on a database of its own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  closeIntegrationDatabase,
  cloneIntegrationDatabase,
  withRollback,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import type { ServerFrame } from '@purlay/types';
import { systemClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { AppError } from '../../platform/errors';
import { sessionTopic, type EventBus } from '../../platform/events';
import { aSession, aTestAuth, TEST_AUTH_SECRET } from '../../testing/signed-in';
import { aUserRow } from '../../testing/users';
import type { Auth } from './better-auth';
import { deviceSessions } from './devices';
import { authorizeNative, exchangeNativeCode } from './native-handoff';
import {
  ACTIVITY_STALE_AFTER_MS,
  endLapsedSession,
  NO_SESSION_LIFETIME,
  noteSessionActivity,
  type SessionLifetime,
} from './session-lifetime';
import { requireSessionFromHeaders, sessionFromHeaders } from './sessions';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const IDLE: SessionLifetime = { sessionIdleTimeoutHours: 8, sessionMaxAgeDays: null };
const MAX_AGE: SessionLifetime = { sessionIdleTimeoutHours: null, sessionMaxAgeDays: 7 };

/** An instant this long before the moment the test asks: the session's own times are travelled, not the clock. */
const ago = (ms: number): Date => new Date(Date.now() - ms);

const withCookie = (token: string): Headers =>
  new Headers({ cookie: `${SESSION_COOKIE}=${token}` });

/** A live session of a new person, minted on the clock the library judges sessions by. */
const aLiveSession = async (
  db: Executor,
  name: string,
): Promise<{ readonly userId: string; readonly sessionId: string; readonly token: string }> => {
  const user = await aUserRow(db, name);
  const { sessionId, token } = await aSession(db, systemClock, user.userId);
  return { userId: user.userId, sessionId, token };
};

/** Moves a session's sign-in and last use into the past, as days and hours of real time would have. */
const travel = async (
  db: Executor,
  sessionId: string,
  times: { readonly createdAt?: Date; readonly lastUsedAt?: Date },
): Promise<void> => {
  await db
    .updateTable('sessions')
    .set({
      ...(times.createdAt === undefined ? {} : { created_at: times.createdAt }),
      ...(times.lastUsedAt === undefined ? {} : { last_used_at: times.lastUsedAt }),
    })
    .where('id', '=', sessionId)
    .execute();
};

const rowOf = async (
  db: Executor,
  sessionId: string,
): Promise<{ readonly last_used_at: Date } | undefined> =>
  await db
    .selectFrom('sessions')
    .select('last_used_at')
    .where('id', '=', sessionId)
    .executeTakeFirst();

describe('integration: the policy, read where every session is read', () => {
  test('off: a session signed in and last used weeks ago resolves as before, untouched by the policy', async () => {
    await withRollback(async (db) => {
      for (const auth of [aTestAuth(db), aTestAuth(db, { sessionLifetime: NO_SESSION_LIFETIME })]) {
        const session = await aLiveSession(db, 'lifetime-off');
        await travel(db, session.sessionId, {
          createdAt: ago(20 * DAY),
          lastUsedAt: ago(20 * DAY),
        });
        expect(await sessionFromHeaders(auth, withCookie(session.token))).toMatchObject({
          sessionId: session.sessionId,
        });
        expect(await rowOf(db, session.sessionId)).toBeDefined();
      }
    });
  });

  test('the idle timeout: just under it resolves, just over it is signed out and its row deleted', async () => {
    await withRollback(async (db) => {
      const auth = aTestAuth(db, { sessionLifetime: IDLE });
      const under = await aLiveSession(db, 'idle-under');
      await travel(db, under.sessionId, { lastUsedAt: ago(8 * HOUR - 60_000) });
      expect(await sessionFromHeaders(auth, withCookie(under.token))).toMatchObject({
        sessionId: under.sessionId,
      });

      const over = await aLiveSession(db, 'idle-over');
      await travel(db, over.sessionId, { lastUsedAt: ago(8 * HOUR + 1000) });
      expect(await sessionFromHeaders(auth, withCookie(over.token))).toBeUndefined();
      expect(await rowOf(db, over.sessionId)).toBeUndefined();
      // The refusal is the one every signed-out request gets (D-60): nothing says why.
      const refusal = await requireSessionFromHeaders(auth, withCookie(over.token)).catch(
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(AppError);
      expect((refusal as AppError).body).toEqual({
        code: 'UNAUTHENTICATED',
        message: 'Sign in first.',
      });
    });
  });

  test('the maximum age: just under it resolves however it is used, just over it is signed out and deleted', async () => {
    await withRollback(async (db) => {
      const auth = aTestAuth(db, { sessionLifetime: MAX_AGE });
      const under = await aLiveSession(db, 'age-under');
      await travel(db, under.sessionId, { createdAt: ago(7 * DAY - 60_000) });
      const owner = await sessionFromHeaders(auth, withCookie(under.token));
      expect(owner?.sessionId).toBe(under.sessionId);
      // What a socket's timer is set to: the maximum age, sooner than the thirty days the row expires at.
      expect(Math.abs((owner?.expiresAt.getTime() ?? 0) - (Date.now() + 60_000))).toBeLessThan(
        5_000,
      );

      const over = await aLiveSession(db, 'age-over');
      // Used a moment ago: use does not keep a session past its maximum age.
      await travel(db, over.sessionId, { createdAt: ago(7 * DAY + 1000), lastUsedAt: ago(1000) });
      expect(await sessionFromHeaders(auth, withCookie(over.token))).toBeUndefined();
      expect(await rowOf(db, over.sessionId)).toBeUndefined();
    });
  });

  test('use moves the idle end: a request refreshes last use once it is five minutes stale, and not before', async () => {
    await withRollback(async (db) => {
      const auth = aTestAuth(db, { sessionLifetime: IDLE });
      const session = await aLiveSession(db, 'idle-use');
      const nearlyIdle = ago(8 * HOUR - 60_000);
      await travel(db, session.sessionId, { lastUsedAt: nearlyIdle });
      const before = Date.now();
      await sessionFromHeaders(auth, withCookie(session.token));
      // The minute it had left is eight hours again.
      expect((await rowOf(db, session.sessionId))?.last_used_at.getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );

      // Ten minutes stale is refreshed while a timeout is set, though D-60's hour has not passed.
      await travel(db, session.sessionId, { lastUsedAt: ago(10 * 60_000) });
      const tenMinutesLater = Date.now();
      await sessionFromHeaders(auth, withCookie(session.token));
      expect((await rowOf(db, session.sessionId))?.last_used_at.getTime()).toBeGreaterThanOrEqual(
        tenMinutesLater - 1000,
      );

      // Four minutes stale is fresh enough: no write (D-60's throttle, at five minutes while a timeout is set).
      const fourMinutes = ago(4 * 60_000);
      await travel(db, session.sessionId, { lastUsedAt: fourMinutes });
      await sessionFromHeaders(auth, withCookie(session.token));
      expect((await rowOf(db, session.sessionId))?.last_used_at).toEqual(fourMinutes);

      // With no timeout set the hour of D-60 stands: half an hour stale is left alone.
      const halfAnHour = ago(30 * 60_000);
      await travel(db, session.sessionId, { lastUsedAt: halfAnHour });
      await sessionFromHeaders(aTestAuth(db), withCookie(session.token));
      expect((await rowOf(db, session.sessionId))?.last_used_at).toEqual(halfAnHour);
    });
  });

  test('the socket’s ACTIVE is use: it refreshes a stale session, leaves a fresh one, and never revives one that lapsed', async () => {
    await withRollback(async (db) => {
      const stale = await aLiveSession(db, 'active-stale');
      await travel(db, stale.sessionId, { lastUsedAt: ago(ACTIVITY_STALE_AFTER_MS + 60_000) });
      const now = new Date();
      await noteSessionActivity(db, IDLE, now, stale.sessionId);
      expect((await rowOf(db, stale.sessionId))?.last_used_at).toEqual(now);

      const fresh = await aLiveSession(db, 'active-fresh');
      const aMinute = ago(60_000);
      await travel(db, fresh.sessionId, { lastUsedAt: aMinute });
      await noteSessionActivity(db, IDLE, new Date(), fresh.sessionId);
      expect((await rowOf(db, fresh.sessionId))?.last_used_at).toEqual(aMinute);

      const lapsedOne = await aLiveSession(db, 'active-lapsed');
      const nineHours = ago(9 * HOUR);
      await travel(db, lapsedOne.sessionId, { lastUsedAt: nineHours });
      await noteSessionActivity(db, IDLE, new Date(), lapsedOne.sessionId);
      expect((await rowOf(db, lapsedOne.sessionId))?.last_used_at).toEqual(nineHours);

      const tooOld = await aLiveSession(db, 'active-old');
      const tenMinutes = ago(10 * 60_000);
      await travel(db, tooOld.sessionId, { createdAt: ago(8 * DAY), lastUsedAt: tenMinutes });
      await noteSessionActivity(
        db,
        { sessionIdleTimeoutHours: 8, sessionMaxAgeDays: 7 },
        new Date(),
        tooOld.sessionId,
      );
      expect((await rowOf(db, tooOld.sessionId))?.last_used_at).toEqual(tenMinutes);

      // No timeout: the socket writes nothing, as before.
      await noteSessionActivity(db, MAX_AGE, new Date(), tooOld.sessionId);
      await noteSessionActivity(db, NO_SESSION_LIFETIME, new Date(), tooOld.sessionId);
      expect((await rowOf(db, tooOld.sessionId))?.last_used_at).toEqual(tenMinutes);
    });
  });

  test('a session used in between is not deleted for what an earlier read saw', async () => {
    await withRollback(async (db) => {
      const session = await aLiveSession(db, 'lapse-recheck');
      await travel(db, session.sessionId, { lastUsedAt: ago(9 * HOUR) });
      // Another request refreshed it after this one read it as lapsed.
      await travel(db, session.sessionId, { lastUsedAt: new Date() });
      expect(await endLapsedSession(db, IDLE, new Date(), session.sessionId)).toBe(false);
      expect(await rowOf(db, session.sessionId)).toBeDefined();
      // Nothing is judged, and nothing deleted, where no rule is on.
      await travel(db, session.sessionId, { lastUsedAt: ago(900 * DAY) });
      expect(await endLapsedSession(db, NO_SESSION_LIFETIME, new Date(), session.sessionId)).toBe(
        false,
      );
      expect(await rowOf(db, session.sessionId)).toBeDefined();
    });
  });

  test('a change of policy reaches the sessions already open, and turning it off gives back one it had not ended', async () => {
    await withRollback(async (db) => {
      const session = await aLiveSession(db, 'policy-change');
      await travel(db, session.sessionId, { lastUsedAt: ago(2 * HOUR) });
      // Each instance is what the server builds from its settings: a change swaps the instance (D-179 §4.9).
      expect(await sessionFromHeaders(aTestAuth(db), withCookie(session.token))).toBeDefined();
      // That read was use; two more hours pass unused.
      await travel(db, session.sessionId, { lastUsedAt: ago(2 * HOUR) });
      const hourly = aTestAuth(db, {
        sessionLifetime: { sessionIdleTimeoutHours: 1, sessionMaxAgeDays: null },
      });
      expect(await sessionFromHeaders(hourly, withCookie(session.token))).toBeUndefined();
      expect(await rowOf(db, session.sessionId)).toBeUndefined();

      const kept = await aLiveSession(db, 'policy-off-again');
      await travel(db, kept.sessionId, { lastUsedAt: ago(2 * HOUR) });
      expect(
        await sessionFromHeaders(aTestAuth(db, { sessionLifetime: IDLE }), withCookie(kept.token)),
      ).toBeDefined();
    });
  });

  test('the device list shows no lapsed session, and says when each ends whatever is done with it', async () => {
    await withRollback(async (db) => {
      const user = await aUserRow(db, 'lifetime-devices');
      const current = await aSession(db, systemClock, user.userId);
      const idle = await aSession(db, systemClock, user.userId);
      const old = await aSession(db, systemClock, user.userId);
      await travel(db, idle.sessionId, { lastUsedAt: ago(9 * HOUR) });
      await travel(db, old.sessionId, { createdAt: ago(8 * DAY) });
      const both: SessionLifetime = { sessionIdleTimeoutHours: 8, sessionMaxAgeDays: 7 };

      const listed = await deviceSessions(db, user.userId, current.sessionId, both);
      expect(listed.map((session) => session.id)).toEqual([current.sessionId]);
      const row = await db
        .selectFrom('sessions')
        .select('created_at')
        .where('id', '=', current.sessionId)
        .executeTakeFirstOrThrow();
      expect(listed[0]?.expiresAt).toBe(new Date(row.created_at.getTime() + 7 * DAY).toISOString());
      // Off, all three are listed, each with its own expiry, as before.
      expect(
        await deviceSessions(db, user.userId, current.sessionId, NO_SESSION_LIFETIME),
      ).toHaveLength(3);
    });
  });
});

const PASSWORD = 'correct horse battery staple';

describe('integration: the policy, at every door that opens connections of its own', () => {
  let cloned: ClonedDatabase;
  /** Every frame published, by topic: what the sockets listening on it would be sent. */
  const heard: [string, ServerFrame][] = [];
  const bus: EventBus = {
    publish: async (topic, frame) => {
      heard.push([topic, frame]);
      await Promise.resolve();
    },
    subscribe: () => true,
    unsubscribe: () => undefined,
    forget: () => undefined,
  };
  let auth: Auth;

  beforeAll(async () => {
    cloned = await cloneIntegrationDatabase();
    auth = aTestAuth(cloned.db, { bus, sessionLifetime: IDLE });
  }, CLONE_HOOK_MS);

  afterAll(async () => {
    await cloned.drop();
  }, DROP_HOOK_MS);

  test('two requests at the instant it lapses are both signed out, and the session ends once', async () => {
    const session = await aLiveSession(cloned.db, 'lapse-race');
    await travel(cloned.db, session.sessionId, { lastUsedAt: ago(8 * HOUR) });
    const answers = await Promise.all([
      sessionFromHeaders(auth, withCookie(session.token)),
      sessionFromHeaders(auth, withCookie(session.token)),
    ]);

    expect(answers).toEqual([undefined, undefined]);
    expect(await rowOf(cloned.db, session.sessionId)).toBeUndefined();
    // However late the other request comes to end it, it finds nothing to end, and says nothing.
    await auth.endLapsedSession(session.sessionId);
    expect(
      heard
        .filter(([topic]) => topic === sessionTopic(session.sessionId))
        .map(([, frame]) => [frame.event, frame.data]),
    ).toEqual([['SESSION_ENDED', { reason: 'expired' }]]);
  });

  /** A person with a password, signed in by the library's own route. */
  const aPasswordPerson = async (
    name: string,
  ): Promise<{ email: string; cookie: string; userId: string }> => {
    const context = await auth.$context;
    const email = `${name}-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const user = await context.internalAdapter.createUser(
      { email, name, emailVerified: true },
      { method: 'email-password' },
    );
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: 'credential',
      accountId: user.id,
      password: await context.password.hash(PASSWORD),
    });
    const signedIn = await auth.passwordSignIn(email, PASSWORD, new Headers());
    const set = signedIn.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    return { email, cookie: set?.split(';')[0] ?? '', userId: user.id };
  };

  const sessionsOf = async (userId: string): Promise<string[]> =>
    (
      await cloned.db.selectFrom('sessions').select('id').where('user_id', '=', userId).execute()
    ).map((row) => row.id);

  test('the library’s own routes hold to it too: a lapsed session changes no password, and signing in again works', async () => {
    const person = await aPasswordPerson('lapse-library');
    const [sessionId = ''] = await sessionsOf(person.userId);
    await travel(cloned.db, sessionId, { lastUsedAt: ago(9 * HOUR) });

    const changed = await auth.handler(
      new Request('https://purlay.test/auth/change-password', {
        method: 'POST',
        headers: {
          cookie: person.cookie,
          origin: 'https://purlay.test',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          currentPassword: PASSWORD,
          newPassword: 'another horse battery staple',
        }),
      }),
    );
    expect(changed.status).toBe(401);
    expect(await sessionsOf(person.userId)).toEqual([]);

    // The old cookie still in the browser does not stand in the way of a new sign-in, with the same password.
    const again = await auth.passwordSignIn(
      person.email,
      PASSWORD,
      new Headers({ cookie: person.cookie }),
    );
    expect(again.status).toBe(200);
    expect(await sessionsOf(person.userId)).toHaveLength(1);
  });

  test('the native application’s session is held to the same policy as a browser’s', async () => {
    const user = await aUserRow(cloned.db, 'lapse-native');
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const { code } = await authorizeNative(cloned.db, systemClock, {
      userId: user.userId,
      challenge,
    });
    const minted = await exchangeNativeCode(
      cloned.db,
      systemClock,
      { secret: TEST_AUTH_SECRET, sessionTtlDays: 30 },
      { code, verifier, deviceName: 'Studio Mac' },
    );
    const token = minted?.token ?? '';
    const aged = aTestAuth(cloned.db, { bus, sessionLifetime: MAX_AGE });
    expect((await sessionFromHeaders(aged, withCookie(token)))?.userId).toBe(user.userId);

    await travel(cloned.db, minted?.sessionId ?? '', { createdAt: ago(7 * DAY + 1000) });
    expect(await sessionFromHeaders(aged, withCookie(token))).toBeUndefined();
    expect(await sessionsOf(user.userId)).toEqual([]);
  });
});

afterAll(async () => {
  await closeIntegrationDatabase();
});
