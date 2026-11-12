/** Independently proven credentials replace the browser's company cookie, including its second step. @needs-modules chat */
import { describe, afterAll, beforeAll, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { signInCompanyNative, companyNativeHeaders } from '../../testing/company-native-auth';
import { aRecordingOutbox } from '../../testing/doubles';
import { aTestAuth } from '../../testing/signed-in';
import { codeAt, keyOf } from '../../testing/totp';
import { systemClock } from '../../platform/clock';
import { COMPANY_SESSION_COOKIE, SESSION_COOKIE, TWO_FACTOR_COOKIE } from '../../platform/cookies';
import { sessionFromHeaders } from './sessions';

describe('integration: company-reauth', () => {
  let clone: ClonedDatabase;
  beforeAll(async () => {
    clone = await cloneIntegrationDatabase();
  }, CLONE_HOOK_MS);
  afterAll(async () => {
    await clone.drop();
    await closeIntegrationDatabase();
  }, DROP_HOOK_MS);
  const PASSWORD = 'independent account access 2026';

  /** Apply every Set-Cookie as a browser does, so a shadowing company cookie cannot be ignored by the test. */
  const browserJar = (
    cookie: string,
  ): {
    readonly headers: () => Headers;
    readonly has: (name: string) => boolean;
    readonly accept: (response: Response) => void;
  } => {
    const entries = new Map<string, string>();
    for (const piece of cookie.split(';')) {
      const at = piece.indexOf('=');
      if (at >= 0) entries.set(piece.slice(0, at).trim(), piece.slice(at + 1).trim());
    }
    return {
      headers: (): Headers =>
        companyNativeHeaders([...entries].map(([name, value]) => `${name}=${value}`).join('; ')),
      has: (name) => entries.has(name),
      accept: (response): void => {
        for (const line of response.headers.getSetCookie()) {
          const first = line.split(';')[0] ?? '';
          const at = first.indexOf('=');
          if (at < 0) throw new Error('Invalid cookie in native response');
          const name = first.slice(0, at);
          if (/;\s*max-age=0(?:;|$)/i.test(line)) entries.delete(name);
          else entries.set(name, first.slice(at + 1));
        }
      },
    };
  };

  const setup = async (): Promise<
    Awaited<ReturnType<typeof signInCompanyNative>> & { readonly email: string }
  > => {
    const world = await signInCompanyNative(clone.db);
    const context = await world.auth.$context;
    await context.internalAdapter.linkAccount({
      userId: world.companySession.userId,
      providerId: 'credential',
      accountId: world.companySession.userId,
      password: await context.password.hash(PASSWORD),
    });
    const user = await clone.db
      .selectFrom('users')
      .select('email')
      .where('id', '=', world.companySession.userId)
      .executeTakeFirstOrThrow();
    return { ...world, email: user.email };
  };

  for (const direct of [false, true])
    test(`independent password proof clears the company cookie through ${direct ? 'the direct facade' : 'the native handler'}`, async () => {
      const world = await setup();
      const jar = browserJar(world.cookie);
      const signIn = async (password: string): Promise<Response> =>
        direct
          ? await world.auth.passwordSignIn(world.email, password, jar.headers())
          : await world.auth.handler(
              new Request('https://purlay.test/auth/sign-in/email', {
                method: 'POST',
                headers: jar.headers(),
                body: JSON.stringify({ email: world.email, password }),
              }),
            );
      const refused = await signIn('incorrect independent password');
      expect(refused.status).toBe(401);
      jar.accept(refused);
      expect(jar.has(COMPANY_SESSION_COOKIE)).toBe(true);
      expect(jar.has(SESSION_COOKIE)).toBe(false);
      expect((await sessionFromHeaders(world.auth, jar.headers()))?.companyWorkspaceId).toBe(
        world.companySession.companyWorkspaceId,
      );
      const accepted = await signIn(PASSWORD);
      expect(accepted.status).toBe(200);
      jar.accept(accepted);
      expect(jar.has(COMPANY_SESSION_COOKIE)).toBe(false);
      expect(jar.has(SESSION_COOKIE)).toBe(true);
      const owner = await sessionFromHeaders(world.auth, jar.headers());
      expect(owner?.userId).toBe(world.companySession.userId);
      expect(owner?.companyWorkspaceId).toBeUndefined();
      expect(owner?.sessionId).not.toBe(world.companySession.sessionId);
    });

  test('a company cookie cannot consume or hide an independently required two-factor challenge', async () => {
    const world = await setup();
    const post = async (path: string, headers: Headers, body: unknown): Promise<Response> =>
      await world.auth.handler(
        new Request(`https://purlay.test/auth${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }),
      );
    const started = await post('/two-factor/enable', companyNativeHeaders(world.memberCookie), {
      password: PASSWORD,
    });
    expect(started.status).toBe(200);
    const data: unknown = await started.json();
    if (
      typeof data !== 'object' ||
      data === null ||
      !('totpURI' in data) ||
      typeof data.totpURI !== 'string'
    )
      throw new Error('No authenticator enrollment');
    const key = keyOf(data.totpURI);
    expect(
      (
        await post('/two-factor/verify-totp', companyNativeHeaders(world.memberCookie), {
          code: codeAt(key, systemClock.now().getTime()),
        })
      ).status,
    ).toBe(200);
    const jar = browserJar(world.cookie);
    const challenge = await post('/sign-in/email', jar.headers(), {
      email: world.email,
      password: PASSWORD,
    });
    expect(challenge.status).toBe(200);
    expect(await challenge.json()).toMatchObject({ twoFactorRedirect: true });
    jar.accept(challenge);
    expect(jar.has(TWO_FACTOR_COOKIE)).toBe(true);
    expect(jar.has(SESSION_COOKIE)).toBe(false);
    expect(jar.has(COMPANY_SESSION_COOKIE)).toBe(true);
    const verified = await post('/two-factor/verify-totp', jar.headers(), {
      code: codeAt(key, systemClock.now().getTime()),
    });
    expect(verified.status).toBe(200);
    jar.accept(verified);
    expect(jar.has(COMPANY_SESSION_COOKIE)).toBe(false);
    const owner = await sessionFromHeaders(world.auth, jar.headers());
    expect(owner?.userId).toBe(world.companySession.userId);
    expect(owner?.companyWorkspaceId).toBeUndefined();
  });

  test('an independently spent email link clears the actual browser company cookie and cannot be spent again', async () => {
    const world = await setup();
    const outbox = aRecordingOutbox();
    // Email links are an independent credential only after the native address was proven.
    await clone.db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', world.companySession.userId)
      .execute();
    const auth = aTestAuth(clone.db, { mailer: outbox });
    const links = auth.signInLinks;
    if (links === undefined) throw new Error('No mail sign-in fixture');
    await links.issue(world.email, { locale: 'en' });
    const token = /\/sign-in\/email#([0-9a-f]{64})/.exec(JSON.stringify(outbox.posted))?.[1];
    if (token === undefined) throw new Error('No private sign-in token');
    const jar = browserJar(world.cookie);
    const lines = await links.spend(token, jar.headers());
    expect(lines).toBeDefined();
    const headers = new Headers();
    for (const line of lines ?? []) headers.append('set-cookie', line);
    jar.accept(new Response(null, { headers }));
    expect(jar.has(COMPANY_SESSION_COOKIE)).toBe(false);
    const owner = await sessionFromHeaders(auth, jar.headers());
    expect(owner?.userId).toBe(world.companySession.userId);
    expect(owner?.companyWorkspaceId).toBeUndefined();
    expect(await links.spend(token, jar.headers())).toBeUndefined();
  });
});
