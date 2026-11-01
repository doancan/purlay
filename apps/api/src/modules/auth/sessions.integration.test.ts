/**
 * Sessions through Better Auth, against a real database (D-11, D-60, D-179).
 *
 * The central claims: every way a session can be wrong answers the same nothing, through the one
 * seam both doors use; nothing the `sessions` table holds works as a cookie, with the secret or
 * without it; and every way a session ends — sign out, sign out everywhere, *sign out my other
 * devices*, a new password, a reset — ends it on the next request, on either door.
 *
 * The first part runs inside a transaction that is rolled back (D-46). The library's own sign-in,
 * password and revoke routes open transactions of their own, so the second part runs on a database
 * of its own, as `sockets.integration.test.ts` does, with the library's schema check on. That both
 * doors resolve through this seam, over a running server, is `ingress/http/session.integration.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  cloneIntegrationDatabase,
  sessionTokenDigest,
  sql,
  withRollback,
  type ClonedDatabase,
  type Executor,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { makeSignature } from 'better-auth/crypto';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { SESSION_COOKIE } from '../../platform/cookies';
import { aSession, aSignedInUser, aTestAuth, TEST_AUTH_SECRET } from '../../testing/signed-in';
import { aUserRow } from '../../testing/users';
import type { Auth } from './better-auth';
import { requireSessionFromHeaders, revokeSession, sessionFromHeaders } from './sessions';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);
const ORIGIN = 'https://purlay.test';

const withCookie = (value: string | undefined): Headers =>
  new Headers(value === undefined ? {} : { cookie: `${SESSION_COOKIE}=${value}` });

/** The raw token inside a cookie value: what the library hands out, before its signature. */
const rawTokenOf = (cookieValue: string): string =>
  decodeURIComponent(cookieValue).split('.')[0] ?? '';

const signedWith = async (secret: string, value: string): Promise<string> =>
  encodeURIComponent(`${value}.${await makeSignature(value, secret)}`);

describe('integration: one seam resolves every session', () => {
  test('answers undefined for a missing, malformed, expired and revoked session', async () => {
    await withRollback(async (db) => {
      const auth = aTestAuth(db);
      const user = await aUserRow(db, 'seam-owner');
      const live = await aSession(db, clock, user.userId);
      // The control: without it every "undefined" below would pass for an instance that resolves nothing.
      expect(await sessionFromHeaders(auth, withCookie(live.token))).toMatchObject({
        userId: user.userId,
        sessionId: live.sessionId,
      });

      const raw = rawTokenOf(live.token);
      const tampered = `${raw.slice(0, -1)}${raw.endsWith('0') ? '1' : '0'}`;
      const wrongs: Record<string, Headers> = {
        missing: new Headers(),
        'another cookie only': new Headers({ cookie: 'other=1' }),
        empty: withCookie(''),
        malformed: withCookie('not-a-signed-value'),
        'unsigned raw token': withCookie(raw),
        tampered: withCookie(await signedWith('a-different-secret-of-thirty-two-bytes!', raw)),
        'tampered token, old signature': withCookie(
          encodeURIComponent(`${tampered}.${decodeURIComponent(live.token).split('.')[1] ?? ''}`),
        ),
        unknown: withCookie(await signedWith(TEST_AUTH_SECRET, 'f'.repeat(64))),
      };
      for (const [why, headers] of Object.entries(wrongs)) {
        expect([why, await sessionFromHeaders(auth, headers)]).toEqual([why, undefined]);
      }

      const expired = await aSession(db, clock, user.userId);
      await db
        .updateTable('sessions')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', expired.sessionId)
        .execute();
      expect(await sessionFromHeaders(auth, withCookie(expired.token))).toBeUndefined();

      const revoked = await aSession(db, clock, user.userId);
      expect(await revokeSession(db, revoked.sessionId)).toBe(revoked.sessionId);
      expect(await sessionFromHeaders(auth, withCookie(revoked.token))).toBeUndefined();

      // The refusal is one error, whichever way the session was wrong (D-60).
      for (const headers of [new Headers(), withCookie(revoked.token), withCookie(expired.token)]) {
        const refusal = await requireSessionFromHeaders(auth, headers).catch((e: unknown) => e);
        expect(refusal).toBeInstanceOf(AppError);
        expect((refusal as AppError).body).toEqual({
          code: 'UNAUTHENTICATED',
          message: 'Sign in first.',
        });
      }
      // And the session that was never wrong is still there.
      expect(await sessionFromHeaders(auth, withCookie(live.token))).toBeDefined();
    });
  });

  test('stores nothing in sessions that works as the cookie', async () => {
    await withRollback(async (db) => {
      const auth = aTestAuth(db);
      const user = await aUserRow(db, 'seam-dump');
      const live = await aSession(db, clock, user.userId);
      const raw = rawTokenOf(live.token);

      const { rows } = await sql<Record<string, unknown>>`
        select * from sessions where id = ${live.sessionId}`.execute(db);
      const row = rows[0] ?? {};
      // The raw token appears in no column: a token in `user_agent` would pass a narrower check.
      expect(Object.values(row).map(String)).not.toContain(raw);
      expect(row['token_hash']).toBe(sessionTokenDigest(raw));

      // Every value the row holds, as a cookie: alone, and signed with the very secret.
      for (const value of Object.values(row).map(String)) {
        expect(await sessionFromHeaders(auth, withCookie(value))).toBeUndefined();
        expect(
          await sessionFromHeaders(auth, withCookie(await signedWith(TEST_AUTH_SECRET, value))),
        ).toBeUndefined();
      }
      // The control: the cookie itself still works, so the refusals above were about the values.
      expect(await sessionFromHeaders(auth, withCookie(live.token))).toBeDefined();
    });
  });

  test("a deleted user's session stops working", async () => {
    await withRollback(async (db) => {
      const auth = aTestAuth(db);
      const user = await aUserRow(db, 'session-deleted');
      const { token } = await aSession(db, clock, user.userId);
      // The control: alive before the account is gone.
      expect(await sessionFromHeaders(auth, withCookie(token))).toBeDefined();
      await db
        .updateTable('users')
        .set({ deleted_at: NOW })
        .where('id', '=', user.userId)
        .execute();
      expect(await sessionFromHeaders(auth, withCookie(token))).toBeUndefined();
    });
  });

  test('a soft-deleted person cannot start a session, by any sign-in of the library', async () => {
    await withRollback(async (db) => {
      const context = await aTestAuth(db).$context;
      const user = await aUserRow(db, 'session-deleted-start');
      // The control: the same call makes a session for a live account.
      expect(await context.internalAdapter.createSession(user.userId)).toMatchObject({
        userId: user.userId,
      });
      await db
        .updateTable('users')
        .set({ deleted_at: NOW })
        .where('id', '=', user.userId)
        .execute();
      const before = await db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', user.userId)
        .execute();
      const refused = await context.internalAdapter.createSession(user.userId).then(
        (made) => made,
        (error: unknown) => error,
      );
      expect(refused === null || refused instanceof Error).toBe(true);
      expect(
        await db.selectFrom('sessions').select('id').where('user_id', '=', user.userId).execute(),
      ).toEqual(before);
    });
  });

  /**
   * `last_used_at` is refreshed lazily, at most once an hour: writing it on every request would put an
   * `UPDATE` on the hottest path, and not writing it at all would make it fiction (D-60).
   */
  test('last_used_at is refreshed when stale, and left alone when fresh', async () => {
    await withRollback(async (db) => {
      const auth = aTestAuth(db);
      const user = await aUserRow(db, 'session-seen');
      // Minted on the fixed clock, weeks behind the clock the seam reads: stale.
      const { token, sessionId } = await aSession(db, clock, user.userId);
      const readBack = async (): Promise<number> =>
        new Date(
          (
            await db
              .selectFrom('sessions')
              .select('last_used_at')
              .where('id', '=', sessionId)
              .executeTakeFirstOrThrow()
          ).last_used_at,
        ).getTime();
      expect(await readBack()).toBe(NOW.getTime());

      const before = Date.now();
      await sessionFromHeaders(auth, withCookie(token));
      const touched = await readBack();
      expect(touched).toBeGreaterThanOrEqual(before - 1000);

      // Fresh now: a minute later it is left alone.
      const aMinuteAgo = new Date(Date.now() - 60_000);
      await db
        .updateTable('sessions')
        .set({ last_used_at: aMinuteAgo })
        .where('id', '=', sessionId)
        .execute();
      await sessionFromHeaders(auth, withCookie(token));
      expect(await readBack()).toBe(aMinuteAgo.getTime());
    });
  });

  test('a database failure is an error, never read as signed out', async () => {
    await withRollback(async (db) => {
      const alice = await aSignedInUser(db, clock, 'seam-down');
      const broken: Executor = db.withPlugin({
        transformQuery: () => {
          throw new Error('the database is down');
        },
        transformResult: (args) => Promise.resolve(args.result),
      });
      const failure = await sessionFromHeaders(
        aTestAuth(broken),
        new Headers({ cookie: alice.cookie }),
      ).catch((e: unknown) => e);
      // The failure itself, not the library's wrapping of it, and never `undefined`.
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe('the database is down');
    });
  });
});

/** A person with a password, signed in through the library, as many times as asked. */
interface Person {
  readonly userId: string;
  readonly email: string;
  /** Each a `Cookie` header, one per device. */
  readonly devices: string[];
}

const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'another horse battery staple';

const cookieFrom = (response: Response): string => {
  const set = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (set === undefined)
    throw new Error(`no session cookie set (status ${String(response.status)})`);
  return set.split(';')[0] ?? '';
};

describe('integration: every way the library ends a session', () => {
  let cloned: ClonedDatabase;
  let auth: Auth;

  beforeAll(async () => {
    cloned = await cloneIntegrationDatabase();
    auth = aTestAuth(cloned.db, { baseUrl: ORIGIN });
  }, CLONE_HOOK_MS);

  afterAll(async () => {
    await cloned.drop();
  }, DROP_HOOK_MS);

  const signIn = async (email: string, password = PASSWORD): Promise<string> =>
    cookieFrom(await auth.passwordSignIn(email, password, new Headers()));

  const aPerson = async (name: string, devices = 3): Promise<Person> => {
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
    const signedIn: string[] = [];
    for (let i = 0; i < devices; i += 1) signedIn.push(await signIn(email));
    return { userId: user.id, email, devices: signedIn };
  };

  const alive = async (cookie: string): Promise<boolean> =>
    (await sessionFromHeaders(auth, new Headers({ cookie }))) !== undefined;

  const storedHashes = async (userId: string): Promise<string[]> =>
    (
      await cloned.db
        .selectFrom('sessions')
        .select('token_hash')
        .where('user_id', '=', userId)
        .execute()
    ).map((row) => row.token_hash);

  /** Every row the person has is a digest of a token a live cookie carries, and nothing else. */
  const expectOnlyDigests = async (person: Person, cookies: readonly string[]): Promise<void> => {
    const raws = cookies.map((cookie) => rawTokenOf(cookie.slice(SESSION_COOKIE.length + 1)));
    const stored = await storedHashes(person.userId);
    for (const raw of raws) expect(stored).not.toContain(raw);
    expect(stored.toSorted()).toEqual(raws.map(sessionTokenDigest).toSorted());
  };

  test('the cookie cache is off, so a revoked session is dead on the next request', async () => {
    expect((await auth.$context).options.session?.cookieCache?.enabled).toBe(false);
    const signedIn = await auth.passwordSignIn(
      (await aPerson('cache', 0)).email,
      PASSWORD,
      new Headers(),
    );
    // No copy of the session travels in a cookie of its own.
    expect(signedIn.headers.getSetCookie().map((c) => c.split('=')[0])).toEqual([SESSION_COOKIE]);
    // Everything the browser was handed, sent back as a browser would: with a cache on, this would
    // carry the session's copy too.
    const cookie = signedIn.headers
      .getSetCookie()
      .map((set) => set.split(';')[0] ?? '')
      .join('; ');
    expect(await alive(cookie)).toBe(true);
    const owner = await sessionFromHeaders(auth, new Headers({ cookie }));
    await revokeSession(cloned.db, owner?.sessionId ?? '');
    expect(await alive(cookie)).toBe(false);
  });

  test('revokeOtherSessions ends B and C and keeps A, through the route and the API', async () => {
    const person = await aPerson('others');
    const [a = '', b = '', c = ''] = person.devices;
    const answer = await auth.handler(
      new Request(`${ORIGIN}/auth/revoke-other-sessions`, {
        method: 'POST',
        headers: { cookie: a, origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect([answer.status, await answer.json()]).toEqual([200, { status: true }]);
    expect([await alive(a), await alive(b), await alive(c)]).toEqual([true, false, false]);
    await expectOnlyDigests(person, [a]);

    // The library's own name for it is ours too: the built-in is replaced, not shadowed.
    const again = await aPerson('others-api');
    const [x = '', y = ''] = again.devices;
    expect(await auth.api.revokeOtherSessions({ headers: new Headers({ cookie: x }) })).toEqual({
      status: true,
    });
    expect([await alive(x), await alive(y)]).toEqual([true, false]);
  });

  test('revokeOtherSessions without a session is 401, and ends nothing', async () => {
    const person = await aPerson('others-anon', 2);
    const answer = await auth.handler(
      new Request(`${ORIGIN}/auth/revoke-other-sessions`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(answer.status).toBe(401);
    for (const cookie of person.devices) expect(await alive(cookie)).toBe(true);
  });

  test('a listed digest ends nothing when handed back as a token', async () => {
    const person = await aPerson('digest', 2);
    const [a = '', b = ''] = person.devices;
    const listed = await auth.api.listSessions({ headers: new Headers({ cookie: a }) });
    const digests = listed.map((session) => session.token);
    expect(digests.toSorted()).toEqual((await storedHashes(person.userId)).toSorted());
    for (const token of digests) {
      // The library looks the token up — hashed again — finds no session of the caller's and, as it
      // does for any token that is not one, answers `{ status: true }` having deleted nothing. That
      // answer, and nothing else: a refusal of another kind would be a different path.
      expect(
        await auth.api.revokeSession({ headers: new Headers({ cookie: a }), body: { token } }),
      ).toEqual({ status: true });
    }
    expect([await alive(a), await alive(b)]).toEqual([true, true]);
  });

  const changePassword = async (cookie: string, body: Record<string, unknown>): Promise<Response> =>
    // Through the handler, as every change of a password is: its attempt is counted there.
    await auth.handler(
      new Request(`${ORIGIN}/auth/change-password`, {
        method: 'POST',
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  const rowsOf = async (userId: string): Promise<{ id: string; token_hash: string }[]> =>
    await cloned.db
      .selectFrom('sessions')
      .select(['id', 'token_hash'])
      .where('user_id', '=', userId)
      .orderBy('id')
      .execute();

  test('changing the password keeps the caller’s own session row and ends the others, and only theirs', async () => {
    const person = await aPerson('change');
    const bystander = await aPerson('change-bystander', 1);
    const [a = '', b = '', c = ''] = person.devices;
    const before = await rowsOf(person.userId);
    const callerRow = before.find(
      (row) =>
        row.token_hash === sessionTokenDigest(rawTokenOf(a.slice(SESSION_COOKIE.length + 1))),
    );
    expect(callerRow).toBeDefined();
    const bystanderRows = await rowsOf(bystander.userId);

    // The client's own `false` changes nothing: the others end whatever it sent.
    const changed = await changePassword(a, {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      revokeOtherSessions: false,
    });
    expect(changed.status).toBe(200);
    // No new session, no new cookie: the caller's is the one it was.
    expect(changed.headers.getSetCookie().some((x) => x.startsWith(`${SESSION_COOKIE}=`))).toBe(
      false,
    );
    expect([await alive(a), await alive(b), await alive(c)]).toEqual([true, false, false]);
    expect(await rowsOf(person.userId)).toEqual(callerRow === undefined ? [] : [callerRow]);
    expect(callerRow).toBeDefined();
    expect(await rowsOf(bystander.userId)).toEqual(bystanderRows);
    expect(await alive(bystander.devices[0] ?? '')).toBe(true);
    // The password changed: the old one fails, the new one works.
    expect((await auth.passwordSignIn(person.email, PASSWORD, new Headers())).status).toBe(401);
    expect((await auth.passwordSignIn(person.email, NEW_PASSWORD, new Headers())).status).toBe(200);
  });

  test('a wrong current password changes nothing and ends nothing', async () => {
    const person = await aPerson('change-wrong');
    const before = await rowsOf(person.userId);
    const refused = await changePassword(person.devices[0] ?? '', {
      currentPassword: 'not the password at all',
      newPassword: NEW_PASSWORD,
    });
    expect(refused.status).toBe(400);
    expect(await rowsOf(person.userId)).toEqual(before);
    expect((await auth.passwordSignIn(person.email, PASSWORD, new Headers())).status).toBe(200);
  });

  test('a weak new password is refused and ends nothing', async () => {
    const person = await aPerson('change-weak');
    const before = await rowsOf(person.userId);
    const refused = await changePassword(person.devices[0] ?? '', {
      currentPassword: PASSWORD,
      newPassword: 'short',
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await rowsOf(person.userId)).toEqual(before);
    expect((await auth.passwordSignIn(person.email, PASSWORD, new Headers())).status).toBe(200);
  });

  test('when the other sessions cannot be ended the answer says so, and the password did change', async () => {
    const person = await aPerson('change-fails', 2);
    const [a = ''] = person.devices;
    await sql`create function refuse_session_delete() returns trigger language plpgsql as $$ begin raise exception 'sessions are frozen'; end $$`.execute(
      cloned.db,
    );
    await sql`create trigger refuse_session_delete before delete on sessions for each row execute function refuse_session_delete()`.execute(
      cloned.db,
    );
    let failed: Response;
    try {
      failed = await changePassword(a, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    } finally {
      await sql`drop trigger refuse_session_delete on sessions`.execute(cloned.db);
      await sql`drop function refuse_session_delete()`.execute(cloned.db);
    }
    expect(failed.status).toBe(500);
    const answer = (await failed.json()) as { code?: string; message?: string };
    expect(answer.code).toBe('OTHER_SESSIONS_NOT_ENDED');
    expect(answer.message).toContain('Sign out everywhere');
    // The truth behind the answer: the password changed, the caller's session lives, the other stays.
    expect((await auth.passwordSignIn(person.email, NEW_PASSWORD, new Headers())).status).toBe(200);
    expect(await alive(a)).toBe(true);
    expect((await rowsOf(person.userId)).length).toBeGreaterThanOrEqual(3);
  });

  test('a password reset ends every session', async () => {
    const person = await aPerson('reset');
    const context = await auth.$context;
    const token = `reset-${crypto.randomUUID()}`;
    await context.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: person.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await auth.api.resetPassword({ body: { newPassword: NEW_PASSWORD, token } })).toEqual({
      status: true,
    });
    for (const cookie of person.devices) expect(await alive(cookie)).toBe(false);
    expect(await storedHashes(person.userId)).toEqual([]);
    expect(await alive(await signIn(person.email, NEW_PASSWORD))).toBe(true);
  });

  /**
   * Every session path of the library this server uses, run in turn, and after each the table holds
   * digests of the live tokens and nothing else. An upgrade that writes the token another way either
   * fails here or is refused by the hashing plugin, loudly.
   */
  test('every session path the library takes here leaves only digests behind', async () => {
    const person = await aPerson('paths', 2);
    const [a = ''] = person.devices;
    let [, b = ''] = person.devices;
    await expectOnlyDigests(person, [a, b]);

    // No refresh: a session read near the end of its life is neither extended nor re-signed (R25),
    // so the one path that would rewrite its token is not one this server takes.
    const nearTheEnd = new Date(Date.now() + 60 * 60 * 1000);
    await cloned.db
      .updateTable('sessions')
      .set({ expires_at: nearTheEnd })
      .where('token_hash', '=', sessionTokenDigest(rawTokenOf(a.slice(SESSION_COOKIE.length + 1))))
      .execute();
    const read = await auth.api.getSession({
      headers: new Headers({ cookie: a }),
      asResponse: true,
    });
    expect(read.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(false);
    const kept = await cloned.db
      .selectFrom('sessions')
      .select('expires_at')
      .where('token_hash', '=', sessionTokenDigest(rawTokenOf(a.slice(SESSION_COOKIE.length + 1))))
      .executeTakeFirstOrThrow();
    expect(new Date(kept.expires_at).getTime()).toBe(nearTheEnd.getTime());
    expect(await alive(a)).toBe(true);
    await expectOnlyDigests(person, [a, b]);

    const listed = await auth.api.listSessions({ headers: new Headers({ cookie: a }) });
    expect(listed).toHaveLength(2);

    const signedOut = await auth.api.signOut({
      headers: new Headers({ cookie: b }),
      asResponse: true,
    });
    expect(signedOut.status).toBe(200);
    expect(await alive(b)).toBe(false);
    await expectOnlyDigests(person, [a]);

    b = await signIn(person.email);
    await auth.api.revokeSession({
      headers: new Headers({ cookie: a }),
      body: { token: rawTokenOf(b.slice(SESSION_COOKIE.length + 1)) },
    });
    expect(await alive(b)).toBe(false);
    await expectOnlyDigests(person, [a]);

    await auth.api.revokeSessions({ headers: new Headers({ cookie: a }) });
    expect(await alive(a)).toBe(false);
    expect(await storedHashes(person.userId)).toEqual([]);
  });
});

afterAll(async () => {
  await closeIntegrationDatabase();
});
