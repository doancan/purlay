/**
 * Signing in by an email link through the real application (D-138, as amended by D-179): Better
 * Auth's magic link, its token in the link's fragment and nowhere else, shown by its address before
 * it is spent, spent once, and every answer to the asker the same whatever the address is.
 *
 * Each link is read out of the mail the outbox was handed, as a person would read it; the library's
 * own routes are knocked on to show they are closed.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { SIGN_IN_LINK_TTL_MINUTES } from '@purlay/types';
import { SESSION_COOKIE } from '../../platform/cookies';
import type { MailMessage } from '../../platform/mail';
import { tokenDigest } from '../../platform/tokens';
import {
  aMovableClock,
  aRecordingLogger,
  aRecordingOutbox,
  NOW,
  testDependencies,
  testConfig,
  type TestOverrides,
} from '../../testing/doubles';
import {
  SIGN_IN_LINKS_PER_ADDRESS,
  SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT,
  SIGN_IN_REQUESTS_PER_HOUR,
} from '../../modules/auth/magic-link';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const APP = 'https://purlay.test';

type App = ReturnType<typeof createApp>;

const anApp = (db: Executor, overrides: TestOverrides = {}): App =>
  createApp(testDependencies({ database: db, ...overrides }));

const post = async (
  app: App,
  path: string,
  body: unknown,
  cookie?: string,
  client?: string,
): Promise<Response> =>
  await app.handle(
    new Request(`${APP}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: APP,
        ...(cookie === undefined ? {} : { cookie }),
        ...(client === undefined ? {} : { 'x-forwarded-for': client }),
      },
      body: JSON.stringify(body),
    }),
  );

const ask = async (
  app: App,
  email: string,
  more: Record<string, unknown> = {},
): Promise<Response> => {
  const response = await post(app, '/auth/email', { email, locale: 'en', ...more });
  // What a request comes to is decided after its answer (D-138 §1): waited for, as the thing expected.
  await app.settled();
  return response;
};

/** Asked from `client`, as the proxy in front of the server names it. */
const askFrom = async (app: App, client: string, email: string): Promise<Response> => {
  const response = await post(app, '/auth/email', { email, locale: 'en' }, undefined, client);
  await app.settled();
  return response;
};

/** An app behind a proxy, so each request says which client it came from. */
const behindAProxy = (db: Executor, overrides: TestOverrides = {}): App =>
  anApp(db, { config: testConfig({ TRUST_PROXY: true }), ...overrides });

const codeOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { error?: { code?: unknown } }).error?.code;

/** The link a message carries, whole: the first address in it that opens this server. */
const linkIn = (message: MailMessage | undefined): URL => {
  const found = /https:\/\/purlay\.test\/\S*/.exec(message?.text ?? '')?.[0];
  if (found === undefined) throw new Error('the message carries no link');
  return new URL(found);
};

const tokenIn = (message: MailMessage | undefined): string => {
  const token = /^#([0-9a-f]{64})(?:[.~]|$)/.exec(linkIn(message).hash)?.[1];
  if (token === undefined) throw new Error('the link carries no token in its fragment');
  return token;
};

/** How Better Auth 1.7.12 keeps a link with `storeToken: 'hashed'`, as measured: base64url SHA-256. */
const storedIdentifier = async (token: string): Promise<string> =>
  `magic-link:${Buffer.from(await tokenDigest(token), 'hex').toString('base64url')}`;

const verificationsFor = async (
  db: Executor,
  email: string,
): Promise<{ identifier: string; value: string; expires_at: Date; created_at: Date }[]> =>
  await db
    .selectFrom('verifications')
    .select(['identifier', 'value', 'expires_at', 'created_at'])
    .where('value', 'like', `%${email}%`)
    .execute();

/** An account of the given shape at `email`, as each way of making one leaves it. */
const anAccount = async (
  db: Executor,
  email: string,
  shape: {
    readonly verified: boolean;
    readonly githubId?: string;
    readonly deleted?: boolean;
    readonly password?: boolean;
  },
): Promise<string> => {
  const local = email.slice(0, email.indexOf('@'));
  const { id } = await db
    .insertInto('users')
    .values({
      email,
      username: `${local}-${crypto.randomUUID().slice(0, 6)}`,
      display_name: local,
      email_verified: shape.verified,
      github_id: shape.githubId ?? null,
      deleted_at: shape.deleted === true ? NOW : null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  if (shape.password === true) {
    await db
      .insertInto('accounts')
      .values({
        user_id: id,
        account_id: id,
        provider_id: 'credential',
        password: 'a-hash-the-library-made',
      })
      .execute();
  }
  return id;
};

describe('integration: asking for a sign-in link', () => {
  test('off without mail: 503, said, and nothing written', async () => {
    await withRollback(async (db) => {
      const response = await ask(anApp(db), 'someone@example.test');
      const body = (await response.clone().json()) as { error: { message: string } };
      expect([response.status, await codeOf(response)]).toEqual([503, 'EMAIL_SIGN_IN_UNAVAILABLE']);
      // Not a word of GitHub: on a server waiting for its setup there is none to sign in with.
      expect(body.error.message).toBe('This server does not sign in by email.');
      expect(await verificationsFor(db, 'someone@example.test')).toEqual([]);
    });
  });

  test('sends a link whose token is in the fragment, never the path or query', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const { log, lines } = aRecordingLogger();
      const response = await ask(anApp(db, { mail, log, signUp: 'open' }), 'Someone@Example.test');
      expect([response.status, await response.text()]).toEqual([202, '']);
      expect(mail.posted.map((message) => message.to)).toEqual(['someone@example.test']);
      const link = linkIn(mail.posted[0]);
      expect([link.origin, link.pathname, link.search]).toEqual([APP, '/sign-in/email', '']);
      const token = tokenIn(mail.posted[0]);
      expect(mail.posted[0]?.html).toContain(`href="${APP}/sign-in/email#${token}"`);
      expect(mail.posted[0]?.text).toContain(`${String(SIGN_IN_LINK_TTL_MINUTES)} minutes`);
      // The library's row: the token only as its digest, the address in the value and never in the
      // identifier (D-179), open for the fifteen minutes and no longer.
      const [row, ...more] = await verificationsFor(db, 'someone@example.test');
      expect(more).toEqual([]);
      expect(row?.identifier).toBe(await storedIdentifier(token));
      expect(JSON.stringify(row)).not.toContain(token);
      expect(JSON.parse(row?.value ?? '')).toEqual({
        type: 'magic-link',
        email: 'someone@example.test',
      });
      expect((row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)).toBeWithin(
        SIGN_IN_LINK_TTL_MINUTES * 60_000 - 1_000,
        SIGN_IN_LINK_TTL_MINUTES * 60_000 + 1_000,
      );
      // The request line is written after the response: waited for, as the thing expected.
      for (let waited = 0; !lines.some((line) => line['msg'] === 'request'); waited += 1) {
        if (waited > 100) throw new Error('the request was never logged');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const written = JSON.stringify(lines);
      expect(written).not.toContain('someone@example.test');
      expect(written).not.toContain(token);
    });
  });

  test('in the language asked for, with an invitation riding after the token', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const invitation = 'c'.repeat(64);
      await ask(anApp(db, { mail, signUp: 'open' }), 'invited@example.test', {
        locale: 'tr',
        invitation,
      });
      expect(mail.posted[0]?.subject).toBe('Purlay giriş bağlantın');
      const token = tokenIn(mail.posted[0]);
      expect(linkIn(mail.posted[0]).hash).toBe(`#${token}.${invitation}`);
    });
  });

  test('with the native application’s challenge and state riding after the token, and after an invitation (D-191)', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = anApp(db, { mail, signUp: 'open' });
      const native = { challenge: 'a'.repeat(43), state: 'b'.repeat(22) };
      await ask(app, 'native@example.test', { native });
      const token = tokenIn(mail.posted[0]);
      expect(linkIn(mail.posted[0]).hash).toBe(`#${token}~${native.challenge}~${native.state}`);

      const invitation = 'c'.repeat(64);
      await ask(app, 'both@example.test', { native, invitation });
      const second = tokenIn(mail.posted[1]);
      expect(linkIn(mail.posted[1]).hash).toBe(
        `#${second}.${invitation}~${native.challenge}~${native.state}`,
      );
    });
  });

  test('answers the same whether or not the address has an account', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      await anAccount(db, 'email@example.test', { verified: true });
      await anAccount(db, 'github@example.test', { verified: true, githubId: '4242' });
      await anAccount(db, 'admin@example.test', { verified: false, password: true });
      await anAccount(db, 'erased@example.test', { verified: true, deleted: true });
      const app = anApp(db, { mail });
      // An address past its five for the hour: the sixth answer is one more to compare.
      for (let n = 0; n < SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT; n += 1) {
        await ask(app, 'spent@example.test');
      }
      const answers: string[] = [];
      for (const email of [
        'nobody@example.test',
        'email@example.test',
        'github@example.test',
        'admin@example.test',
        'erased@example.test',
        'spent@example.test',
      ]) {
        const response = await ask(app, email);
        // Every header, but one that names the request itself.
        const headers = [...response.headers.entries()].filter(
          ([name]) => !/request-id/i.test(name),
        );
        answers.push(JSON.stringify([response.status, headers, await response.text()]));
      }
      expect(new Set(answers).size).toBe(1);
      expect(JSON.parse(answers[0] ?? '[]')).toMatchObject([202, expect.any(Array), '']);
      // What each was sent: a link into the email account; a word to use GitHub, and no link; and
      // nothing to an address no account has on an invite-only server, to an unverified password
      // account (its password would go, D-179 §4), or to an erased one.
      expect(
        mail.posted.map((message) => message.to).filter((to) => to !== 'spent@example.test'),
      ).toEqual(['email@example.test', 'github@example.test']);
      expect(tokenIn(mail.posted[0])).toHaveLength(64);
      expect(mail.posted[1]?.text).toContain('Continue with GitHub');
      expect(mail.posted[1]?.text).not.toContain('/sign-in/email');
      for (const email of ['nobody', 'github', 'admin', 'erased']) {
        expect(await verificationsFor(db, `${email}@example.test`)).toEqual([]);
      }
      expect(
        await db
          .selectFrom('users')
          .select('id')
          .where('email', '=', 'nobody@example.test')
          .execute(),
      ).toEqual([]);
    });
  });

  test('refuses the sixth link in an hour; the next hour sends again', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const clock = aMovableClock();
      const app = anApp(db, { mail, clock, signUp: 'open' });
      for (let n = 0; n <= SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT; n += 1) {
        expect((await ask(app, 'busy@example.test')).status).toBe(202);
      }
      expect(mail.posted).toHaveLength(SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT);
      // Counted in the database, by digests and never the address (D-179 §3): the client's, the
      // address's from that client, and the address's from every client (D-231 §2).
      const counters = await db
        .selectFrom('rate_limits')
        .select('key')
        .where('key', 'like', 'purlay:sign-in-link:%')
        .execute();
      expect(counters).toHaveLength(3);
      expect(JSON.stringify(counters)).not.toContain('busy');
      clock.advance(60 * 60_000 - 1);
      await ask(app, 'busy@example.test');
      expect(mail.posted).toHaveLength(SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT);
      clock.advance(1);
      await ask(app, 'busy@example.test');
      expect(mail.posted).toHaveLength(SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT + 1);
    });
  });

  test('a stranger asking for an address all hour does not keep its owner from signing in (D-231 §2)', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = behindAProxy(db, { mail, signUp: 'open' });
      // As many as the stranger's client may ask in the hour, every one for the same address.
      for (let n = 0; n < SIGN_IN_REQUESTS_PER_HOUR; n += 1) {
        expect((await askFrom(app, '198.51.100.7', 'victim@example.test')).status).toBe(202);
      }
      expect(mail.posted).toHaveLength(SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT);
      // The owner, from their own client, is sent a link all the same.
      expect((await askFrom(app, '203.0.113.9', 'victim@example.test')).status).toBe(202);
      expect(mail.posted).toHaveLength(SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT + 1);
      expect(tokenIn(mail.posted.at(-1))).toHaveLength(64);
      // One IPv6 subscriber is one client, whichever of its /64's addresses it asks from.
      for (let n = 0; n <= SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT; n += 1) {
        await askFrom(app, `2001:db8:1:2::${String(n + 1)}`, 'other@example.test');
      }
      expect(mail.posted.filter((message) => message.to === 'other@example.test')).toHaveLength(
        SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT,
      );
    });
  });

  test('an address is sent no more than its ceiling in an hour, however many clients ask (D-231 §2)', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = behindAProxy(db, { mail, signUp: 'open' });
      for (let n = 0; n <= SIGN_IN_LINKS_PER_ADDRESS; n += 1) {
        expect(
          (await askFrom(app, `192.0.2.${String(n + 1)}`, 'flooded@example.test')).status,
        ).toBe(202);
      }
      expect(mail.posted).toHaveLength(SIGN_IN_LINKS_PER_ADDRESS);
      expect(SIGN_IN_LINKS_PER_ADDRESS).toBeGreaterThan(SIGN_IN_LINKS_PER_ADDRESS_AND_CLIENT);
    });
  });

  test('one client past its links for the hour, across addresses: the same 202, and nothing sent', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = anApp(db, { mail, signUp: 'open' });
      const statuses: number[] = [];
      for (let n = 0; n <= SIGN_IN_REQUESTS_PER_HOUR; n += 1) {
        statuses.push((await ask(app, `person-${String(n)}@example.test`)).status);
      }
      expect(new Set(statuses)).toEqual(new Set([202]));
      expect(mail.posted).toHaveLength(SIGN_IN_REQUESTS_PER_HOUR);
      expect(mail.posted.map((message) => message.to)).not.toContain(
        `person-${String(SIGN_IN_REQUESTS_PER_HOUR)}@example.test`,
      );
    });
  });

  test('what the contract refuses is refused, a name or a username among it', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = anApp(db, { mail, signUp: 'open' });
      for (const body of [
        { email: 'a@example.test', locale: 'fr' },
        { email: 'a@example.test', locale: 'en', next: '/evil' },
        // The library would take a `name` for the account it makes; nobody is given one here.
        { email: 'a@example.test', locale: 'en', name: 'Administrator' },
        { email: 'a@example.test', locale: 'en', username: 'admin' },
        { email: 'a@example.test', locale: 'en', callbackURL: 'https://evil.test' },
        // An invitation rides in the mail (D-138 §4): nothing but a token's shape may get there.
        { email: 'a@example.test', locale: 'en', invitation: 'c'.repeat(63) },
        { email: 'a@example.test', locale: 'en', invitation: 'C'.repeat(64) },
        {
          email: 'a@example.test',
          locale: 'en',
          invitation: `${'c'.repeat(32)}\n\nYour account is locked: https://evil.test`,
        },
        // The native pair is written into a mail the person opens: the contract's patterns and nothing else.
        {
          email: 'a@example.test',
          locale: 'en',
          native: { challenge: 'a'.repeat(42), state: 'b'.repeat(22) },
        },
        {
          email: 'a@example.test',
          locale: 'en',
          native: { challenge: 'a'.repeat(43), state: 'b&c'.repeat(8) },
        },
        {
          email: 'a@example.test',
          locale: 'en',
          native: {
            challenge: 'a'.repeat(43),
            state: 'b'.repeat(22),
            redirect: 'https://evil.test',
          },
        },
        { email: 'a@example.test', locale: 'en', native: { challenge: 'a'.repeat(43) } },
        { email: 'a@example.test', locale: 'en', native: 'x' },
        { email: `${'a'.repeat(250)}@example.test`, locale: 'en' },
      ]) {
        const response = await post(app, '/auth/email', body);
        expect([response.status, await codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
      }
      // What a mail library reads as one mailbox inside another, or not an address at all (D-138 §7).
      for (const email of [
        'nobody',
        'a@b',
        'a b@example.test',
        'a@example.test\r\nBcc: x@y.z',
        'x<victim@example.test>',
        'victim@example.test,foo',
        '"x"@example.test',
        'a..b@example.test',
        'ü@example.test',
        // What the library's own check refuses, refused first: never a 500 out of its route.
        'a%b@example.test',
        'a!b@example.test',
        "o'@example.test",
        'a@example.t',
        'a@example.123',
      ]) {
        const response = await ask(app, email);
        expect([response.status, await codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
      }
      expect(mail.posted).toEqual([]);
      // An address as people write them is taken.
      for (const email of ['a.b+notes@mail.example.test', "o'brien@example.test", 'x_1@a-b.test']) {
        expect((await ask(app, email)).status).toBe(202);
      }
      expect(mail.posted).toHaveLength(3);
    });
  });

  test('the library’s own routes for a link are closed: asking with a name, and spending by GET', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = anApp(db, { mail, signUp: 'open' });
      const asked = await post(app, '/auth/sign-in/magic-link', {
        email: 'direct@example.test',
        name: 'Administrator',
      });
      expect([asked.status, await codeOf(asked)]).toEqual([404, 'ROUTE_NOT_FOUND']);
      expect(mail.posted).toEqual([]);
      expect(await verificationsFor(db, 'direct@example.test')).toEqual([]);

      // A scanner that opens the library's own link would spend it: that route answers nothing, and
      // the link still opens afterwards.
      await ask(app, 'scanned@example.test');
      const token = tokenIn(mail.posted[0]);
      const scanned = await app.handle(
        new Request(`${APP}/auth/magic-link/verify?token=${token}`, { headers: { origin: APP } }),
      );
      expect([scanned.status, await codeOf(scanned)]).toEqual([404, 'ROUTE_NOT_FOUND']);
      expect((await post(app, '/auth/email/consume', { token })).status).toBe(204);
    });
  });
});

describe('integration: using a sign-in link', () => {
  test('shown, then used: a session that opens the API, and an account made by D-138’s rules', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const { log, lines } = aRecordingLogger();
      const app = anApp(db, { mail, log, signUp: 'open' });
      await ask(app, 'Ada.Lovelace+notes@Example.TEST');
      const token = tokenIn(mail.posted[0]);

      // Shown twice: showing spends nothing (D-138 §4), so a scanner that opens the page signs nobody in.
      for (let n = 0; n < 2; n += 1) {
        const shown = await post(app, '/auth/email/preview', { token });
        expect([shown.status, await shown.json()]).toEqual([
          200,
          { email: 'ada.lovelace+notes@example.test' },
        ]);
      }

      const used = await post(app, '/auth/email/consume', { token });
      expect(used.status).toBe(204);
      const cookie = (used.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
      expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
      const me = await app.handle(new Request(`${APP}/api/me`, { headers: { cookie } }));
      expect(me.status).toBe(200);
      expect(((await me.json()) as { user: { email: string } }).user.email).toBe(
        'ada.lovelace+notes@example.test',
      );
      const made = await db
        .selectFrom('users')
        .select(['username', 'display_name', 'email_verified', 'github_id'])
        .where('email', '=', 'ada.lovelace+notes@example.test')
        .executeTakeFirstOrThrow();
      // The link proved the address, and the name is the address's local part, made a username.
      expect(made).toEqual({
        username: 'ada-lovelace-notes',
        display_name: 'ada-lovelace-notes',
        email_verified: true,
        github_id: null,
      });

      for (let waited = 0; lines.filter((l) => l['msg'] === 'request').length < 4; waited += 1) {
        if (waited > 100) throw new Error('the requests were never logged');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(JSON.stringify(lines)).not.toContain(token);
      expect(JSON.stringify(lines)).not.toContain('ada.lovelace');
    });
  });

  test('accepts a link once and refuses it the second time, shown or used', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = anApp(db, { mail, signUp: 'open' });
      await anAccount(db, 'known@example.test', { verified: true });
      await ask(app, 'known@example.test');
      const token = tokenIn(mail.posted[0]);
      expect((await post(app, '/auth/email/consume', { token })).status).toBe(204);
      for (const path of ['/auth/email/consume', '/auth/email/preview']) {
        const again = await post(app, path, { token });
        expect([again.status, await codeOf(again)]).toEqual([404, 'SIGN_IN_LINK_NOT_FOUND']);
      }
      // The library's row is gone with the spend.
      expect(await verificationsFor(db, 'known@example.test')).toEqual([]);
    });
  });

  test('a verified account that has a password and GitHub keeps both after signing in by link', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = anApp(db, { mail });
      const userId = await anAccount(db, 'both@example.test', { verified: true, password: true });
      await db
        .insertInto('accounts')
        .values({ user_id: userId, account_id: '5150', provider_id: 'github' })
        .execute();
      await ask(app, 'both@example.test');
      expect(
        (await post(app, '/auth/email/consume', { token: tokenIn(mail.posted[0]) })).status,
      ).toBe(204);
      const kept = await db
        .selectFrom('accounts')
        .select(['provider_id', 'password'])
        .where('user_id', '=', userId)
        .orderBy('provider_id')
        .execute();
      expect(kept.map((row) => [row.provider_id, row.password])).toEqual([
        ['credential', 'a-hash-the-library-made'],
        ['github', null],
      ]);
    });
  });

  test('a link past its fifteen minutes, one never made and one malformed: refused alike', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = anApp(db, { mail, signUp: 'open' });
      await ask(app, 'late@example.test');
      const late = tokenIn(mail.posted[0]);
      await db
        .updateTable('verifications')
        .set({ expires_at: new Date(Date.now() - 1) })
        .where('identifier', '=', await storedIdentifier(late))
        .execute();
      const bodies: unknown[] = [];
      for (const token of [late, 'f'.repeat(64)]) {
        for (const path of ['/auth/email/preview', '/auth/email/consume']) {
          const response = await post(app, path, { token });
          bodies.push([response.status, await response.json()]);
        }
      }
      expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
      const [first] = bodies as [[number, { error: { code: string } }]];
      expect([first[0], first[1].error.code]).toEqual([404, 'SIGN_IN_LINK_NOT_FOUND']);
      expect(
        await db
          .selectFrom('users')
          .select('id')
          .where('email', '=', 'late@example.test')
          .execute(),
      ).toEqual([]);
      for (const body of [{ token: 'short' }, { token: 'G'.repeat(64) }, {}]) {
        const response = await post(app, '/auth/email/consume', body);
        expect([response.status, await codeOf(response)]).toEqual([400, 'VALIDATION_FAILED']);
      }
    });
  });

  test('a link sent while sign-up was open makes no account once it is invite-only', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      await ask(anApp(db, { mail, signUp: 'open' }), 'late-comer@example.test');
      const token = tokenIn(mail.posted[0]);
      const closed = anApp(db, { mail, signUp: 'invite-only' });
      for (const path of ['/auth/email/preview', '/auth/email/consume']) {
        const response = await post(closed, path, { token });
        expect([response.status, await codeOf(response)]).toEqual([404, 'SIGN_IN_LINK_NOT_FOUND']);
      }
      expect(
        await db
          .selectFrom('users')
          .select('id')
          .where('email', '=', 'late-comer@example.test')
          .execute(),
      ).toEqual([]);
    });
  });

  test('a link never opens an account that became GitHub’s, or was erased, since it was sent', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = anApp(db, { mail, signUp: 'open' });
      await ask(app, 'turned@example.test');
      await ask(app, 'gone@example.test');
      const [turned, gone] = [tokenIn(mail.posted[0]), tokenIn(mail.posted[1])];
      await anAccount(db, 'turned@example.test', { verified: true, githubId: '777' });
      await anAccount(db, 'gone@example.test', { verified: true, deleted: true });
      for (const token of [turned, gone]) {
        const response = await post(app, '/auth/email/consume', { token });
        expect([response.status, await codeOf(response)]).toEqual([404, 'SIGN_IN_LINK_NOT_FOUND']);
      }
    });
  });

  test('an address with nothing to name gets a random name, not one of a hundred numbered ones', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const app = anApp(db, { mail, signUp: 'open' });
      await ask(app, 'here@example.test');
      expect(
        (await post(app, '/auth/email/consume', { token: tokenIn(mail.posted[0]) })).status,
      ).toBe(204);
      const made = await db
        .selectFrom('users')
        .select(['username', 'display_name'])
        .where('email', '=', 'here@example.test')
        .executeTakeFirstOrThrow();
      expect(made.username).toMatch(/^user-[0-9a-f]{6}$/);
      expect(made.display_name).toBe(made.username);
    });
  });
});

describe('integration: a link and an account whose address was never proven (D-179 §4, Ruling R32)', () => {
  /**
   * The setup administrator's account: a password, an address not verified, a session. A link to the
   * address is made before the account is, as one asked for on an open server and left in a mailbox.
   */
  const anUnprovenAdministrator = async (
    db: Executor,
  ): Promise<{ app: App; token: string; userId: string }> => {
    const mail = aRecordingOutbox();
    const app = anApp(db, { mail, signUp: 'open' });
    await ask(app, 'admin@example.test');
    const token = tokenIn(mail.posted[0]);
    const userId = await anAccount(db, 'admin@example.test', { verified: false, password: true });
    await db
      .insertInto('sessions')
      .values({
        user_id: userId,
        token_hash: 'a-session-of-the-administrator',
        expires_at: new Date(Date.now() + 60 * 60_000),
      })
      .execute();
    return { app, token, userId };
  };

  const whatIsLeft = async (
    db: Executor,
    userId: string,
  ): Promise<{ verified: boolean; passwords: number; sessions: number }> => ({
    verified: (
      await db
        .selectFrom('users')
        .select('email_verified')
        .where('id', '=', userId)
        .executeTakeFirstOrThrow()
    ).email_verified,
    passwords: (
      await db
        .selectFrom('accounts')
        .select('id')
        .where('user_id', '=', userId)
        .where('provider_id', '=', 'credential')
        .execute()
    ).length,
    sessions: (await db.selectFrom('sessions').select('id').where('user_id', '=', userId).execute())
      .length,
  });

  test('the link is refused as one that does not open, and the password and session survive', async () => {
    await withRollback(async (db) => {
      const { app, token, userId } = await anUnprovenAdministrator(db);
      for (const path of ['/auth/email/preview', '/auth/email/consume']) {
        const response = await post(app, path, { token });
        expect([response.status, await codeOf(response)]).toEqual([404, 'SIGN_IN_LINK_NOT_FOUND']);
      }
      expect(await whatIsLeft(db, userId)).toEqual({ verified: false, passwords: 1, sessions: 1 });
    });
  });

  test('asked of the library directly, where no transaction can undo it, the password is never removed', async () => {
    await withRollback(async (db) => {
      const mail = aRecordingOutbox();
      const deps = testDependencies({ database: db, mail, signUp: 'open' });
      const links = deps.auth.signInLinks;
      if (links === undefined) throw new Error('sign-in by link is not on');
      await links.issue('admin@example.test', { locale: 'en' });
      const token = tokenIn(mail.posted[0]);
      const userId = await anAccount(db, 'admin@example.test', { verified: false, password: true });
      // Inside the test's transaction the library writes in place, so only a refusal before the
      // first delete keeps the password: the second lock, the one that needs no transaction.
      expect(await links.spend(token, new Headers())).toBeUndefined();
      expect(await whatIsLeft(db, userId)).toMatchObject({ verified: false, passwords: 1 });
    });
  });
});
