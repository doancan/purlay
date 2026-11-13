/** Native primary/second-step evidence is actual authentication, not a session or enrollment timestamp. @needs-modules chat */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { symmetricEncrypt } from 'better-auth/crypto';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  type ClonedDatabase,
  type Selectable,
  type SessionAuthenticationEvidence,
} from '@purlay/db';
import { systemClock } from '../../platform/clock';
import { COMPANY_SESSION_COOKIE, SESSION_COOKIE, TWO_FACTOR_COOKIE } from '../../platform/cookies';
import { aMovableClock, aRecordingOutbox } from '../../testing/doubles';
import { aSession, aTestAuth } from '../../testing/signed-in';
import { aUserRow } from '../../testing/users';
import { aWrongCode, codeAt } from '../../testing/totp';
import { signInCompanyNative } from '../../testing/company-native-auth';
import { aGitHubAuth, aGitHubFor, aGitHubPerson } from '../../testing/github-sign-in';
import { anOidcStub } from '../../testing/oidc-stub';
import { anOidcAuth } from '../../testing/oidc-sign-in';
import { aGoogleAuth, aGoogleStub } from '../../testing/google-sign-in';
import { CLIENT_ADDRESS_HEADER, type Auth } from './better-auth';
import { sessionFromHeaders } from './sessions';
import { tokenDigest } from '../../platform/tokens';
import {
  consumeSecondFactorPrimary,
  recordPrimaryAuthentication,
  rememberSecondFactorPrimary,
  retainUnknownAuthentication,
} from './authentication-evidence';

let clone: ClonedDatabase;
beforeAll(async () => {
  clone = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);
const PASSWORD = 'native authentication evidence long phrase 2026';
let nextAddress = 1;

interface Jar {
  readonly headers: () => Headers;
  readonly accept: (response: Response) => void;
  readonly has: (name: string) => boolean;
}

const jar = (initial = ''): Jar => {
  const values = new Map<string, string>();
  const address = `203.0.113.${String(nextAddress++)}`;
  const read = (piece: string): void => {
    const at = piece.indexOf('=');
    if (at > 0) values.set(piece.slice(0, at).trim(), piece.slice(at + 1));
  };
  for (const part of initial.split(';')) read(part);
  return {
    headers: (): Headers =>
      new Headers({
        cookie: [...values].map(([key, value]) => `${key}=${value}`).join('; '),
        origin: 'https://purlay.test',
        'content-type': 'application/json',
        [CLIENT_ADDRESS_HEADER]: address,
      }),
    accept: (response): void => {
      for (const cookie of response.headers.getSetCookie()) {
        const piece = cookie.split(';')[0] ?? '';
        if (/;\s*max-age=0(?:;|$)/iu.test(cookie)) values.delete(piece.split('=')[0] ?? '');
        else read(piece);
      }
    },
    has: (name) => values.has(name),
  };
};

const post = async (auth: Auth, browser: Jar, path: string, body: unknown): Promise<Response> =>
  await auth.handler(
    new Request(`https://purlay.test/auth${path}`, {
      method: 'POST',
      headers: browser.headers(),
      body: JSON.stringify(body),
    }),
  );

const passwordUser = async (): Promise<{
  readonly auth: Auth;
  readonly clock: ReturnType<typeof aMovableClock>;
  readonly userId: string;
  readonly email: string;
}> => {
  const clock = aMovableClock(systemClock.now());
  const user = await aUserRow(clone.db, 'authentication-owner');
  const auth = aTestAuth(clone.db, { clock });
  const context = await auth.$context;
  await context.internalAdapter.linkAccount({
    userId: user.userId,
    accountId: user.userId,
    providerId: 'credential',
    password: await context.password.hash(PASSWORD),
  });
  return { auth, clock, userId: user.userId, email: user.email };
};

type PasswordUser = Awaited<ReturnType<typeof passwordUser>>;
const expectFailure = async (action: Promise<unknown>, message: string): Promise<void> => {
  const outcome: unknown = await action.catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
  expect(outcome instanceof Error ? outcome.message : 'unexpected success').toBe(message);
};
const signIn = async (world: PasswordUser, browser: Jar): Promise<Response> => {
  const response = await world.auth.passwordSignIn(world.email, PASSWORD, browser.headers());
  browser.accept(response);
  return response;
};

const evidenceFor = async (
  sessionId: string,
): Promise<Selectable<SessionAuthenticationEvidence> | undefined> =>
  await clone.db
    .selectFrom('session_authentication_evidence')
    .selectAll()
    .where('session_id', '=', sessionId)
    .executeTakeFirst();

const establishedFactor = async (world: PasswordUser): Promise<Buffer> => {
  const secret = `factor-${crypto.randomUUID()}`;
  const context = await world.auth.$context;
  await clone.db
    .insertInto('two_factors')
    .values({
      id: crypto.randomUUID(),
      user_id: world.userId,
      secret: await symmetricEncrypt({ key: context.secretConfig, data: secret }),
      backup_codes: await symmetricEncrypt({
        key: context.secretConfig,
        data: JSON.stringify(['recovery-code-for-native-evidence']),
      }),
      verified: true,
    })
    .execute();
  await clone.db
    .updateTable('users')
    .set({ two_factor_enabled: true })
    .where('id', '=', world.userId)
    .execute();
  return Buffer.from(secret);
};

const failEvidenceWrites = async (): Promise<() => Promise<void>> => {
  await sql`create sequence authentication_evidence_fault_hits`.execute(clone.db);
  await sql`create function authentication_evidence_fault() returns trigger language plpgsql as $$
    begin perform nextval('authentication_evidence_fault_hits'); raise exception 'injected native evidence failure'; end $$`.execute(
    clone.db,
  );
  await sql`create trigger authentication_evidence_fault before insert or update on session_authentication_evidence
    for each row execute function authentication_evidence_fault()`.execute(clone.db);
  return async (): Promise<void> => {
    await sql`drop trigger authentication_evidence_fault on session_authentication_evidence`.execute(
      clone.db,
    );
    await sql`drop function authentication_evidence_fault()`.execute(clone.db);
    await sql`drop sequence authentication_evidence_fault_hits`.execute(clone.db);
  };
};

describe('integration: native authentication evidence', () => {
  test('a wrong password records nothing; actual independent sign-in records the verified method and refresh leaves its time alone', async () => {
    const world = await passwordUser();
    const browser = jar();
    expect(
      (await world.auth.passwordSignIn(world.email, 'incorrect password', browser.headers()))
        .status,
    ).toBe(401);
    expect(
      await clone.db
        .selectFrom('session_authentication_evidence')
        .select('session_id')
        .where('user_id', '=', world.userId)
        .execute(),
    ).toEqual([]);
    const authenticatedAt = world.clock.now();
    expect((await signIn(world, browser)).status).toBe(200);
    const owner = await sessionFromHeaders(world.auth, browser.headers());
    expect(owner).toBeDefined();
    const original = await evidenceFor(owner?.sessionId ?? '');
    expect(original?.method).toBe('password');
    expect(original?.authenticated_at).toEqual(authenticatedAt);
    world.clock.advance(5 * 60_000);
    expect((await sessionFromHeaders(world.auth, browser.headers()))?.sessionId).toBe(
      owner?.sessionId,
    );
    expect(await evidenceFor(owner?.sessionId ?? '')).toEqual(original);
  });

  test('password first-step time survives a native challenge; wrong code and repeated native200 create no later MFA event', async () => {
    const world = await passwordUser();
    const key = await establishedFactor(world);
    const browser = jar();
    const firstStep = world.clock.now();
    const pending = await signIn(world, browser);
    expect(pending.status).toBe(200);
    expect(((await pending.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(
      true,
    );
    expect(browser.has(TWO_FACTOR_COOKIE)).toBe(true);
    expect(browser.has(SESSION_COOKIE)).toBe(false);
    expect(
      await clone.db
        .selectFrom('session_authentication_evidence')
        .select('session_id')
        .where('user_id', '=', world.userId)
        .execute(),
    ).toEqual([]);
    world.clock.advance(5 * 60_000);
    expect(
      (
        await post(world.auth, browser, '/two-factor/verify-totp', {
          code: aWrongCode(key, Date.now()),
        })
      ).status,
    ).toBe(401);
    const code = codeAt(key, Date.now());
    const accepted = await post(world.auth, browser, '/two-factor/verify-totp', {
      code,
      trustDevice: true,
    });
    expect(accepted.status).toBe(200);
    browser.accept(accepted);
    const owner = await sessionFromHeaders(world.auth, browser.headers());
    const original = await evidenceFor(owner?.sessionId ?? '');
    expect(original?.method).toBe('password');
    expect(original?.authenticated_at).toEqual(firstStep);
    expect(original?.global_mfa_method).toBe('totp');
    expect(original?.global_mfa_verified_at).toEqual(world.clock.now());
    expect(accepted.headers.getSetCookie().some((cookie) => cookie.includes('trust_device'))).toBe(
      false,
    );
    world.clock.advance(60_000);
    expect((await post(world.auth, browser, '/two-factor/verify-totp', { code })).status).toBe(200);
    expect(await evidenceFor(owner?.sessionId ?? '')).toEqual(original);
  });

  test('a legacy native challenge without primary metadata remains unknown after genuine MFA', async () => {
    const world = await passwordUser();
    const key = await establishedFactor(world);
    const browser = jar();
    expect((await signIn(world, browser)).status).toBe(200);
    await clone.db
      .deleteFrom('verifications')
      .where('identifier', 'like', 'native-primary-2fa:%')
      .execute();
    const verified = await post(world.auth, browser, '/two-factor/verify-totp', {
      code: codeAt(key, Date.now()),
    });
    expect(verified.status).toBe(200);
    browser.accept(verified);
    const proof = await evidenceFor(
      (await sessionFromHeaders(world.auth, browser.headers()))?.sessionId ?? '',
    );
    expect(proof?.method).toBeNull();
    expect(proof?.authenticated_at).toBeNull();
    expect(proof?.global_mfa_method).toBe('totp');
  });

  test('enrollment verification retains an unknown session and changes only its actual global-MFA proof', async () => {
    const world = await passwordUser();
    const issued = await aSession(clone.db, systemClock, world.userId);
    const browser = jar(`${SESSION_COOKIE}=${issued.token}`);
    const pending = await post(world.auth, browser, '/two-factor/enable', { password: PASSWORD });
    expect(pending.status).toBe(200);
    const { keyOf } = await import('../../testing/totp');
    const key = keyOf(((await pending.json()) as { totpURI: string }).totpURI);
    const before = await clone.db
      .selectFrom('two_factors')
      .select('assurance_revision')
      .where('user_id', '=', world.userId)
      .executeTakeFirstOrThrow();
    expect(
      (
        await post(world.auth, browser, '/two-factor/verify-totp', {
          code: codeAt(key, Date.now()),
        })
      ).status,
    ).toBe(200);
    expect((await sessionFromHeaders(world.auth, browser.headers()))?.sessionId).toBe(
      issued.sessionId,
    );
    expect(
      await clone.db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', world.userId)
        .execute(),
    ).toEqual([{ id: issued.sessionId }]);
    const factor = await clone.db
      .selectFrom('two_factors')
      .select(['assurance_revision', 'last_assurance_counter'])
      .where('user_id', '=', world.userId)
      .executeTakeFirstOrThrow();
    const proof = await evidenceFor(issued.sessionId);
    expect(proof?.method).toBeNull();
    expect(proof?.authenticated_at).toBeNull();
    expect(factor.assurance_revision).not.toBe(before.assurance_revision);
    expect(proof?.global_mfa_factor_revision).toBe(factor.assurance_revision);
    expect(proof?.global_mfa_counter).toBe(factor.last_assurance_counter);
  });

  test('one native recovery code preserves the first password time and captures the changed factor revision', async () => {
    const world = await passwordUser();
    await establishedFactor(world);
    const browser = jar();
    const firstStep = world.clock.now();
    expect((await signIn(world, browser)).status).toBe(200);
    world.clock.advance(60_000);
    const verified = await post(world.auth, browser, '/two-factor/verify-backup-code', {
      code: 'recovery-code-for-native-evidence',
      trustDevice: true,
      disableSession: true,
    });
    expect(verified.status).toBe(200);
    browser.accept(verified);
    const proof = await evidenceFor(
      (await sessionFromHeaders(world.auth, browser.headers()))?.sessionId ?? '',
    );
    expect(proof?.method).toBe('password');
    expect(proof?.authenticated_at).toEqual(firstStep);
    expect(proof?.global_mfa_method).toBe('recovery');
    expect(proof?.global_mfa_counter).toBeNull();
    const factor = await clone.db
      .selectFrom('two_factors')
      .select('assurance_revision')
      .where('user_id', '=', world.userId)
      .executeTakeFirstOrThrow();
    expect(proof?.global_mfa_factor_revision).toBe(factor.assurance_revision);
  });

  test('two real retained sessions cannot turn one accepted TOTP counter into two native MFA events', async () => {
    const world = await passwordUser();
    const key = await establishedFactor(world);
    const one = await aSession(clone.db, systemClock, world.userId),
      two = await aSession(clone.db, systemClock, world.userId);
    const code = codeAt(key, Date.now());
    const answered = await Promise.all(
      [jar(`${SESSION_COOKIE}=${one.token}`), jar(`${SESSION_COOKIE}=${two.token}`)].map(
        async (browser) => await post(world.auth, browser, '/two-factor/verify-totp', { code }),
      ),
    );
    expect(answered.map((response) => response.status)).toEqual([200, 200]);
    expect(
      await clone.db
        .selectFrom('session_authentication_evidence')
        .select('session_id')
        .where('user_id', '=', world.userId)
        .where('global_mfa_verified_at', 'is not', null)
        .execute(),
    ).toHaveLength(1);
  });

  test('a cryptographically matching code on a locked native challenge records no primary or MFA event', async () => {
    const world = await passwordUser();
    const key = await establishedFactor(world);
    const browser = jar();
    expect((await signIn(world, browser)).status).toBe(200);
    await clone.db
      .updateTable('two_factors')
      .set({ locked_until: new Date(Date.now() + 60_000) })
      .where('user_id', '=', world.userId)
      .execute();
    expect(
      (
        await post(world.auth, browser, '/two-factor/verify-totp', {
          code: codeAt(key, Date.now()),
        })
      ).status,
    ).toBe(429);
    expect(
      await clone.db
        .selectFrom('session_authentication_evidence')
        .select('session_id')
        .where('user_id', '=', world.userId)
        .execute(),
    ).toEqual([]);
    expect(
      (
        await clone.db
          .selectFrom('two_factors')
          .select('last_assurance_counter')
          .where('user_id', '=', world.userId)
          .executeTakeFirstOrThrow()
      ).last_assurance_counter,
    ).toBeNull();
  });

  test('concurrent native users retain their own factor identity and immutable password proof', async () => {
    const worlds = await Promise.all([passwordUser(), passwordUser()]);
    const factors = await Promise.all(worlds.map(async (world) => await establishedFactor(world)));
    const browsers = worlds.map(() => jar());
    await Promise.all(
      worlds.map(async (world, index) => {
        const browser = browsers[index];
        const key = factors[index];
        if (browser === undefined || key === undefined)
          throw new Error('Missing concurrent browser');
        expect((await signIn(world, browser)).status).toBe(200);
        const verified = await post(world.auth, browser, '/two-factor/verify-totp', {
          code: codeAt(key, Date.now()),
        });
        expect(verified.status).toBe(200);
        browser.accept(verified);
        const proof = await evidenceFor(
          (await sessionFromHeaders(world.auth, browser.headers()))?.sessionId ?? '',
        );
        const factor = await clone.db
          .selectFrom('two_factors')
          .select(['id', 'assurance_revision'])
          .where('user_id', '=', world.userId)
          .executeTakeFirstOrThrow();
        expect(proof).toMatchObject({
          user_id: world.userId,
          method: 'password',
          global_mfa_factor_id: factor.id,
          global_mfa_factor_revision: factor.assurance_revision,
        });
      }),
    );
  });

  test('a reached SQL failure rolls retained enrollment, its material revision, accepted counter and evidence back together', async () => {
    const world = await passwordUser();
    const issued = await aSession(clone.db, systemClock, world.userId);
    const browser = jar(`${SESSION_COOKIE}=${issued.token}`);
    const pending = await post(world.auth, browser, '/two-factor/enable', { password: PASSWORD });
    expect(pending.status).toBe(200);
    const { keyOf } = await import('../../testing/totp');
    const key = keyOf(((await pending.json()) as { totpURI: string }).totpURI);
    const factorBefore = await clone.db
      .selectFrom('two_factors')
      .select(['assurance_revision', 'last_assurance_counter', 'verified'])
      .where('user_id', '=', world.userId)
      .executeTakeFirstOrThrow();
    const clear = await failEvidenceWrites();
    try {
      await expectFailure(
        post(world.auth, browser, '/two-factor/verify-totp', { code: codeAt(key, Date.now()) }),
        'injected native evidence failure',
      );
      expect(
        (
          await sql<{
            called: boolean;
          }>`select is_called as called from authentication_evidence_fault_hits`.execute(clone.db)
        ).rows[0]?.called,
      ).toBe(true);
      expect(
        await clone.db
          .selectFrom('two_factors')
          .select(['assurance_revision', 'last_assurance_counter', 'verified'])
          .where('user_id', '=', world.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual(factorBefore);
      expect(await evidenceFor(issued.sessionId)).toBeUndefined();
      expect((await sessionFromHeaders(world.auth, browser.headers()))?.sessionId).toBe(
        issued.sessionId,
      );
    } finally {
      await clear();
    }
  });

  test('a failed final primary write restores the native challenge and its first-step proof for a genuine retry', async () => {
    const world = await passwordUser();
    const key = await establishedFactor(world);
    const browser = jar();
    const firstStep = world.clock.now();
    expect((await signIn(world, browser)).status).toBe(200);
    const before = await clone.db
      .selectFrom('verifications')
      .select('id')
      .where('identifier', 'like', 'native-primary-2fa:%')
      .execute();
    const clear = await failEvidenceWrites();
    try {
      await expectFailure(
        post(world.auth, browser, '/two-factor/verify-totp', { code: codeAt(key, Date.now()) }),
        'injected native evidence failure',
      );
      expect(
        (
          await sql<{
            called: boolean;
          }>`select is_called as called from authentication_evidence_fault_hits`.execute(clone.db)
        ).rows[0]?.called,
      ).toBe(true);
      expect(
        await clone.db
          .selectFrom('verifications')
          .select('id')
          .where('identifier', 'like', 'native-primary-2fa:%')
          .execute(),
      ).toEqual(before);
      expect(
        await clone.db
          .selectFrom('sessions')
          .select('id')
          .where('user_id', '=', world.userId)
          .execute(),
      ).toEqual([]);
    } finally {
      await clear();
    }
    world.clock.advance(60_000);
    const retried = await post(world.auth, browser, '/two-factor/verify-totp', {
      code: codeAt(key, Date.now()),
    });
    expect(retried.status).toBe(200);
    browser.accept(retried);
    expect(
      (
        await evidenceFor(
          (await sessionFromHeaders(world.auth, browser.headers()))?.sessionId ?? '',
        )
      )?.authenticated_at,
    ).toEqual(firstStep);
  });

  test('company native sign-in records exact issuer workspace/provider revision while global MFA remains unavailable', async () => {
    const world = await signInCompanyNative(clone.db);
    const proof = await evidenceFor(world.companySession.sessionId);
    expect(proof?.method).toBe('company_oidc');
    expect(proof?.company_workspace_id).toBe(world.companySession.companyWorkspaceId);
    expect(proof?.company_connection_id).toBe(world.connection.id);
    const factor = await clone.db
      .selectFrom('workspace_identity_connections')
      .select('authentication_revision')
      .where('id', '=', world.connection.id)
      .executeTakeFirstOrThrow();
    expect(proof?.company_authentication_revision).toBe(factor.authentication_revision);
    const blocked = await post(world.auth, jar(world.cookie), '/two-factor/verify-totp', {
      code: '123456',
    });
    expect([401, 403]).toContain(blocked.status);
    expect(await evidenceFor(world.companySession.sessionId)).toEqual(proof);
    expect(world.cookie.startsWith(`${COMPANY_SESSION_COOKIE}=`)).toBe(true);
  });

  test('an old unknown row cannot be upgraded by a later proof and erasure still follows its native session', async () => {
    const world = await passwordUser();
    const issued = await aSession(clone.db, systemClock, world.userId);
    await retainUnknownAuthentication(clone.db, issued.sessionId, world.userId);
    await recordPrimaryAuthentication(clone.db, issued.sessionId, world.userId, {
      method: 'password',
      authenticatedAt: systemClock.now(),
    });
    expect((await evidenceFor(issued.sessionId))?.method).toBeNull();
    await expectFailure(
      recordPrimaryAuthentication(clone.db, issued.sessionId, world.userId, {
        method: 'password',
        authenticatedAt: new Date('invalid'),
      }),
      'Invalid authentication time',
    );
    const foreign = await aUserRow(clone.db, 'foreign-evidence-owner');
    await expectFailure(
      recordPrimaryAuthentication(clone.db, issued.sessionId, foreign.userId, {
        method: 'password',
        authenticatedAt: systemClock.now(),
      }),
      'Authentication evidence owner changed',
    );
    await clone.db.deleteFrom('sessions').where('id', '=', issued.sessionId).execute();
    expect(await evidenceFor(issued.sessionId)).toBeUndefined();
  });

  test('only exact unexpired well-formed native challenge metadata supplies a primary proof', async () => {
    const world = await passwordUser();
    const now = systemClock.now();
    const identifier = `2fa-${crypto.randomUUID()}`;
    await rememberSecondFactorPrimary(
      clone.db,
      identifier,
      world.userId,
      now,
      new Date(now.getTime() + 60_000),
    );
    expect(await consumeSecondFactorPrimary(clone.db, identifier, world.userId, now)).toEqual({
      method: 'password',
      authenticatedAt: now,
    });
    expect(
      await consumeSecondFactorPrimary(clone.db, identifier, world.userId, now),
    ).toBeUndefined();
    for (const value of [
      'bad-json',
      '{}',
      JSON.stringify({
        method: 'github',
        userId: world.userId,
        authenticatedAt: now.toISOString(),
      }),
      JSON.stringify({
        method: 'password',
        userId: 'someone-else',
        authenticatedAt: now.toISOString(),
      }),
      JSON.stringify({ method: 'password', userId: world.userId, authenticatedAt: 'bad-time' }),
    ]) {
      const key = `2fa-${crypto.randomUUID()}`;
      await rememberSecondFactorPrimary(
        clone.db,
        key,
        world.userId,
        now,
        new Date(now.getTime() + 60_000),
      );
      await clone.db
        .updateTable('verifications')
        .set({ value })
        .where('identifier', '=', `native-primary-2fa:${await tokenDigest(key)}`)
        .execute();
      expect(await consumeSecondFactorPrimary(clone.db, key, world.userId, now)).toBeUndefined();
    }
  });

  test.each(['github', 'oidc', 'google'] as const)(
    'a genuine %s callback captures its verified native method',
    async (provider) => {
      const id = crypto.randomUUID();
      const fixture = async (): Promise<{
        readonly auth: Auth;
        readonly authorize: (url: string) => { readonly code: string };
      }> => {
        if (provider === 'github') {
          const stub = aGitHubFor(aGitHubPerson(`evidence-${id}`));
          return { auth: aGitHubAuth(clone.db, stub.fetch), authorize: stub.authorize };
        }
        const stub =
          provider === 'google'
            ? await aGoogleStub({ sub: id, email: `evidence-${id}@gmail.com` })
            : await anOidcStub({ sub: id, email: `evidence-${id}@example.test` });
        return {
          auth: provider === 'google' ? aGoogleAuth(clone.db, stub) : anOidcAuth(clone.db, stub),
          authorize: stub.authorize,
        };
      };
      const { auth, authorize } = await fixture();
      const started = await auth.api.signInSocial({
        body: { provider, callbackURL: 'https://purlay.test/' },
        returnHeaders: true,
      });
      expect(started.response.url).toBeDefined();
      const location = new URL(started.response.url ?? '');
      const granted = authorize(location.toString());
      const callback = new URL(location.searchParams.get('redirect_uri') ?? '');
      callback.searchParams.set('code', granted.code);
      callback.searchParams.set('state', location.searchParams.get('state') ?? '');
      const browser = jar();
      const headerResponse = new Response(null, { headers: started.headers });
      browser.accept(headerResponse);
      const returned = await auth.handler(
        new Request(callback.toString(), { headers: browser.headers() }),
      );
      expect(returned.status).toBe(302);
      browser.accept(returned);
      const owner = await sessionFromHeaders(auth, browser.headers());
      expect((await evidenceFor(owner?.sessionId ?? ''))?.method).toBe(
        provider === 'oidc' ? 'server_oidc' : provider,
      );
    },
  );

  test('a genuinely spent verified email link records email_link without claiming a password', async () => {
    const user = await aUserRow(clone.db, 'evidence-mail-owner');
    await clone.db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', user.userId)
      .execute();
    const outbox = aRecordingOutbox();
    const auth = aTestAuth(clone.db, { mailer: outbox });
    const links = auth.signInLinks;
    if (links === undefined) throw new Error('No native email-link fixture');
    await links.issue(user.email, { locale: 'en' });
    // The actual outbound mail carries the bearer token; the stored digest is never used as a login.
    const letter = outbox.posted[0];
    expect(letter).toBeDefined();
    const text = JSON.stringify(letter);
    const matched = /\/sign-in\/email#([0-9a-f]{64})/u.exec(text);
    expect(matched).not.toBeNull();
    const browser = jar();
    const cookies = await links.spend(matched?.[1] ?? '', browser.headers());
    expect(cookies).toBeDefined();
    const headers = new Headers();
    for (const cookie of cookies ?? []) headers.append('set-cookie', cookie);
    browser.accept(new Response(null, { headers }));
    expect(
      (await evidenceFor((await sessionFromHeaders(auth, browser.headers()))?.sessionId ?? ''))
        ?.method,
    ).toBe('email_link');
  });
});
