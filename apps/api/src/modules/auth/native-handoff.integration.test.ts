/**
 * Handing a signed-in person's session to the native application (D-191): a one-time code, made while
 * the person is signed in and spent by the application that started the flow, which proves it is that
 * application by a secret it never sent.
 *
 * On a cloned database, because the properties that matter — one winner when two spend one code, a
 * wrong guess that persists although it is refused — are about real connections and committed rows
 * (D-46, D-77).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { tokenDigest } from '../../platform/tokens';
import { aTestAuth, TEST_AUTH_SECRET } from '../../testing/signed-in';
import { aUserRow } from '../../testing/users';
import { sessionFromHeaders } from './sessions';
import {
  authorizeNative,
  exchangeNativeCode,
  NATIVE_CODE_TTL_MS,
  NATIVE_LIVE_CODES_PER_USER,
  NATIVE_WRONG_VERIFIERS_MAX,
} from './native-handoff';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

const NOW = new Date('2026-10-26T12:00:00.000Z');
const clock = fixedClock(NOW);
const later = (ms: number): ReturnType<typeof fixedClock> =>
  fixedClock(new Date(NOW.getTime() + ms));

const session = { secret: TEST_AUTH_SECRET, sessionTtlDays: 30 };

/** What the application does: a secret of its own, and its SHA-256 in base64url, 43 characters. */
const aVerifier = (): { verifier: string; challenge: string } => {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

const aSignedInPerson = async (): Promise<{ userId: string }> => {
  const user = await aUserRow(cloned.db, 'native');
  return { userId: user.userId };
};

const authorize = async (
  userId: string,
  challenge: string,
  at = clock,
): Promise<{ code: string }> => await authorizeNative(cloned.db, at, { userId, challenge });

const exchange = async (
  code: string,
  verifier: string,
  at = clock,
): Promise<Awaited<ReturnType<typeof exchangeNativeCode>>> =>
  await exchangeNativeCode(cloned.db, at, session, { code, verifier });

/** Whose session this cookie value is, resolved the way every request resolves one. */
const whoseSession = async (cookieValue: string): Promise<string | undefined> => {
  const owner = await sessionFromHeaders(
    aTestAuth(cloned.db),
    new Headers({ cookie: `${SESSION_COOKIE}=${cookieValue}` }),
  );
  return owner?.userId;
};

const sessionsOf = async (userId: string): Promise<number> =>
  (await cloned.db.selectFrom('sessions').select('id').where('user_id', '=', userId).execute())
    .length;

describe('integration: making a code', () => {
  test('is 64 hex digits, of which the database keeps only the digest', async () => {
    const { userId } = await aSignedInPerson();
    const { challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    const rows = await cloned.db
      .selectFrom('native_authorizations')
      .selectAll()
      .where('user_id', '=', userId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code_digest).toBe(await tokenDigest(code));
    // Nothing a copy of the database holds is the code, or the means to make one.
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  test('lasts two minutes from now, on the server’s clock', async () => {
    const { userId } = await aSignedInPerson();
    await authorize(userId, aVerifier().challenge);
    const row = await cloned.db
      .selectFrom('native_authorizations')
      .select(['expires_at', 'created_at'])
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    expect(row.created_at.getTime()).toBe(NOW.getTime());
    expect(row.expires_at.getTime()).toBe(NOW.getTime() + NATIVE_CODE_TTL_MS);
    expect(NATIVE_CODE_TTL_MS).toBe(120_000);
  });

  test('is one of at most five live for a person: the oldest makes room, so a retry never locks anyone out', async () => {
    const { userId } = await aSignedInPerson();
    const codes: string[] = [];
    for (let i = 0; i <= NATIVE_LIVE_CODES_PER_USER; i += 1) {
      const { challenge } = aVerifier();
      codes.push((await authorize(userId, challenge, later(i * 1_000))).code);
    }
    const live = await cloned.db
      .selectFrom('native_authorizations')
      .select('code_digest')
      .where('user_id', '=', userId)
      .execute();
    expect(live).toHaveLength(NATIVE_LIVE_CODES_PER_USER);
    expect(live.map((row) => row.code_digest)).not.toContain(await tokenDigest(codes[0] ?? ''));
    expect(live.map((row) => row.code_digest)).toContain(await tokenDigest(codes.at(-1) ?? ''));
  });

  test('never makes another person’s code room: the cap is per person', async () => {
    const first = await aSignedInPerson();
    const second = await aSignedInPerson();
    for (let i = 0; i < NATIVE_LIVE_CODES_PER_USER; i += 1) {
      await authorize(first.userId, aVerifier().challenge);
    }
    await authorize(second.userId, aVerifier().challenge);
    const mine = await cloned.db
      .selectFrom('native_authorizations')
      .select('id')
      .where('user_id', '=', first.userId)
      .execute();
    expect(mine).toHaveLength(NATIVE_LIVE_CODES_PER_USER);
  });
});

describe('integration: spending a code', () => {
  test('mints the authorising person a session of its own, and spends the code', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    const before = await sessionsOf(userId);

    const minted = await exchange(code, verifier);

    expect(minted).toBeDefined();
    expect(await sessionsOf(userId)).toBe(before + 1);
    expect(await whoseSession(minted?.token ?? '')).toBe(userId);
    const row = await cloned.db
      .selectFrom('native_authorizations')
      .select('spent_at')
      .where('code_digest', '=', await tokenDigest(code))
      .executeTakeFirstOrThrow();
    expect(row.spent_at?.getTime()).toBe(NOW.getTime());
  });

  test('mints a session that lasts as long as any other — thirty days, not the code’s two minutes', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const minted = await exchange((await authorize(userId, challenge)).code, verifier);
    // The session's expiry is read against the wall clock by the library, so it is made from the wall
    // clock (`SESSION_CLOCK`, `sessions.ts`), whatever clock the code was spent by.
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const remaining = (minted?.expiresAt.getTime() ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(thirtyDays - 60_000);
    expect(remaining).toBeLessThanOrEqual(thirtyDays);
  });

  test('records who asked, so an operator reading the sessions can tell a device', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    const minted = await exchangeNativeCode(cloned.db, clock, session, {
      code,
      verifier,
      userAgent: 'Purlay for macOS/1.0.0 (A Mac)',
      ipAddress: '203.0.113.9',
    });
    const row = await cloned.db
      .selectFrom('sessions')
      .select(['user_agent', 'ip_address'])
      .where('id', '=', minted?.sessionId ?? '')
      .executeTakeFirstOrThrow();
    expect(row.user_agent).toBe('Purlay for macOS/1.0.0 (A Mac)');
    expect(String(row.ip_address)).toBe('203.0.113.9');
  });

  test('cannot be spent as somebody else: the session is the authorising person’s and nobody’s other', async () => {
    const alice = await aSignedInPerson();
    const bob = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const minted = await exchange((await authorize(alice.userId, challenge)).code, verifier);
    expect(await whoseSession(minted?.token ?? '')).toBe(alice.userId);
    expect(await whoseSession(minted?.token ?? '')).not.toBe(bob.userId);
  });
});

describe('integration: what is refused, and that every refusal is the same', () => {
  test('a code nobody made', async () => {
    const { verifier } = aVerifier();
    expect(await exchange('0'.repeat(64), verifier)).toBeUndefined();
  });

  test('the right code with the wrong verifier — which mints nothing and is counted', async () => {
    const { userId } = await aSignedInPerson();
    const { challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    const before = await sessionsOf(userId);

    expect(await exchange(code, aVerifier().verifier)).toBeUndefined();

    expect(await sessionsOf(userId)).toBe(before);
    const row = await cloned.db
      .selectFrom('native_authorizations')
      .select(['wrong_verifiers', 'spent_at'])
      .where('code_digest', '=', await tokenDigest(code))
      .executeTakeFirstOrThrow();
    // The refusal is committed: a guess that rolled back with its own refusal could be made forever.
    expect(row.wrong_verifiers).toBe(1);
    expect(row.spent_at).toBeNull();
  });

  // Whoever has seen a code must not be able to take it from the person it was made for (the code is in
  // a URL, which a log, a screen share or another app on the Mac may have read): a wrong guess costs a
  // guess, never the code.
  test('a wrong guess does not burn the code: the application with the right verifier still gets in', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    for (let i = 0; i < NATIVE_WRONG_VERIFIERS_MAX - 1; i += 1) {
      expect(await exchange(code, aVerifier().verifier)).toBeUndefined();
    }
    expect(await exchange(code, verifier)).toBeDefined();
  });

  test('five wrong guesses burn it: the sixth, though it carries the right verifier, finds nothing', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    for (let i = 0; i < NATIVE_WRONG_VERIFIERS_MAX; i += 1) {
      expect(await exchange(code, aVerifier().verifier)).toBeUndefined();
    }
    const before = await sessionsOf(userId);
    expect(await exchange(code, verifier)).toBeUndefined();
    expect(await sessionsOf(userId)).toBe(before);
  });

  test('an expired code, even with the right verifier', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    const before = await sessionsOf(userId);
    expect(await exchange(code, verifier, later(NATIVE_CODE_TTL_MS))).toBeUndefined();
    expect(await sessionsOf(userId)).toBe(before);
  });

  test('a code one millisecond short of its end still opens', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    expect(await exchange(code, verifier, later(NATIVE_CODE_TTL_MS - 1))).toBeDefined();
  });

  test('a code already spent: the second time, with the right verifier, mints nothing and ends nothing', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    const first = await exchange(code, verifier);
    const before = await sessionsOf(userId);

    expect(await exchange(code, verifier)).toBeUndefined();

    expect(await sessionsOf(userId)).toBe(before);
    // The session the first spend made is untouched — a retry that raced it must not cost the person
    // the sign-in it just made, and a code seen in a log must not sign anyone out.
    expect(await whoseSession(first?.token ?? '')).toBe(userId);
  });

  test('a code whose person has since been erased', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    await cloned.db
      .updateTable('users')
      .set({ deleted_at: NOW })
      .where('id', '=', userId)
      .execute();
    const before = await sessionsOf(userId);
    expect(await exchange(code, verifier)).toBeUndefined();
    expect(await sessionsOf(userId)).toBe(before);
  });

  test('is the same answer whichever way it failed, and takes the same shape of work', async () => {
    // One value, not four: nothing a caller sees tells an unknown code from a spent one, a burnt one
    // from an expired one, or a wrong verifier from none (the stance of SIGN_IN_LINK_NOT_FOUND, D-138).
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const live = (await authorize(userId, challenge)).code;
    const spent = (await authorize(userId, challenge)).code;
    await exchange(spent, verifier);
    const answers = [
      await exchange('1'.repeat(64), verifier),
      await exchange(live, aVerifier().verifier),
      await exchange(spent, verifier),
      await exchange(live, verifier, later(NATIVE_CODE_TTL_MS + 1)),
    ];
    expect(answers).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('integration: two at once', () => {
  test('eight spends of one code at the same moment make exactly one session', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);
    const before = await sessionsOf(userId);

    const results = await Promise.all(
      Array.from({ length: 8 }, async () => await exchange(code, verifier)),
    );

    expect(results.filter((minted) => minted !== undefined)).toHaveLength(1);
    expect(await sessionsOf(userId)).toBe(before + 1);
  });

  test('concurrent wrong guesses are all counted, and the code burns at five however they interleave', async () => {
    const { userId } = await aSignedInPerson();
    const { verifier, challenge } = aVerifier();
    const { code } = await authorize(userId, challenge);

    await Promise.all(
      Array.from({ length: 12 }, async () => await exchange(code, aVerifier().verifier)),
    );

    const row = await cloned.db
      .selectFrom('native_authorizations')
      .select('wrong_verifiers')
      .where('code_digest', '=', await tokenDigest(code))
      .executeTakeFirstOrThrow();
    expect(row.wrong_verifiers).toBe(NATIVE_WRONG_VERIFIERS_MAX);
    expect(await exchange(code, verifier)).toBeUndefined();
  });

  test('twelve authorisations by one person at once leave exactly five live: the cap holds under a race', async () => {
    const { userId } = await aSignedInPerson();
    await Promise.all(
      Array.from({ length: 12 }, async () => await authorize(userId, aVerifier().challenge)),
    );
    const live = await cloned.db
      .selectFrom('native_authorizations')
      .select('id')
      .where('user_id', '=', userId)
      .where('spent_at', 'is', null)
      .where('expires_at', '>', NOW)
      .execute();
    expect(live).toHaveLength(NATIVE_LIVE_CODES_PER_USER);
  });

  test('two people authorising at once do not disturb each other’s codes', async () => {
    const people = await Promise.all(Array.from({ length: 6 }, aSignedInPerson));
    const flows = await Promise.all(
      people.map(async ({ userId }) => {
        const { verifier, challenge } = aVerifier();
        return { userId, verifier, code: (await authorize(userId, challenge)).code };
      }),
    );
    const minted = await Promise.all(
      flows.map(async ({ code, verifier }) => await exchange(code, verifier)),
    );
    for (const [index, flow] of flows.entries()) {
      expect(await whoseSession(minted[index]?.token ?? '')).toBe(flow.userId);
    }
  });
});
