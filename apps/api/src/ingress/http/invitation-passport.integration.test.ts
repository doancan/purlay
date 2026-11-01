/**
 * The invitation passport through the real application (D-179 §5, Ruling R51): on an invite-only server a
 * newcomer makes an account by a live invitation link and by nothing else — through GitHub with the cookie
 * the passport route set, or through an email link for the address the passport was made for.
 *
 * On a cloned database with real connections, because the passport is spent inside the sign-in library's
 * own transaction and two sign-ups using one passport race on a row lock, which a test's single
 * rolled-back transaction cannot hold (D-46, D-77). GitHub is the strict stub; mail is read from the
 * outbox as a person would read it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  sql,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
} from '@purlay/db';
import { createApp } from './app';
import { AUTH_BUDGET, COSTLY_READ_BUDGET, WRITE_BUDGET } from './rate-limit';
import { INVITE_COOKIE } from '../../platform/cookies';
import { tokenDigest } from '../../platform/tokens';
import { PASSPORTS_PER_INVITATION } from '../../modules/workspaces/invitation-passport';
import {
  aMovableClock,
  aRecordingLogger,
  aRecordingOutbox,
  testDependencies,
  type TestOverrides,
} from '../../testing/doubles';
import {
  aGitHubAuth,
  aGitHubFor,
  aGitHubPerson,
  cookiesFrom,
  returnFromGitHub,
  startGitHubSignIn,
  type GitHubStub,
} from '../../testing/github-sign-in';
import { aSignedInUser, aTestAuth, type SignedInUser } from '../../testing/signed-in';
import { anOidcStub, type OidcPerson, type OidcStub } from '../../testing/oidc-stub';
import { anOidcAuth, returnFromOidc, startOidcSignIn } from '../../testing/oidc-sign-in';
import { aUniqueSlug } from '../../testing/users';
import { normalisedMailbox } from '@purlay/types';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const ORIGIN = 'https://purlay.test';
const HOUR = 60 * 60 * 1000;

type App = ReturnType<typeof createApp>;

interface Server {
  readonly app: App;
  readonly clock: ReturnType<typeof aMovableClock>;
  readonly mail: ReturnType<typeof aRecordingOutbox>;
  readonly logs: ReturnType<typeof aRecordingLogger>;
}

/** A server on the clone: invite-only unless said, with GitHub (the stub) and a relay (the outbox). */
const aServer = (
  github: GitHubStub,
  options: { readonly signUp?: 'open' | 'invite-only'; readonly overrides?: TestOverrides } = {},
): Server => {
  const clock = aMovableClock();
  const mail = aRecordingOutbox();
  const logs = aRecordingLogger();
  const signUp = options.signUp ?? 'invite-only';
  const app = createApp(
    testDependencies({
      database: cloned.db,
      clock,
      log: logs.log,
      mail,
      signUp,
      auth: aGitHubAuth(cloned.db, github.fetch, {
        baseUrl: ORIGIN,
        signUp,
        mailer: mail,
        clock,
        log: logs.log,
      }),
      ...options.overrides,
    }),
  );
  return { app, clock, mail, logs };
};

const post = async (
  app: App,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> =>
  await app.handle(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    }),
  );

const errorCode = async (response: Response): Promise<unknown> =>
  ((await response.clone().json()) as { error?: { code?: unknown } }).error?.code;

/** An owner's workspace and a link into it, made over HTTP. */
const anInvitation = async (
  server: Server,
  name: string,
): Promise<{ owner: SignedInUser; workspaceId: string; token: string }> => {
  const owner = await aSignedInUser(cloned.db, server.clock, `${name}-owner`);
  const headers = { cookie: owner.cookie };
  const created = await post(
    server.app,
    '/api/workspaces',
    { name, slug: aUniqueSlug(name) },
    headers,
  );
  const { id: workspaceId } = (await created.json()) as { id: string };
  const made = await post(server.app, `/api/workspaces/${workspaceId}/invitations`, {}, headers);
  expect(made.status).toBe(201);
  const { token } = (await made.json()) as { token: string };
  return { owner, workspaceId, token };
};

/** The passport for a browser: its cookie pair, as the browser would send it back, and the raw header. */
const aGitHubPassport = async (
  server: Server,
  token: string,
): Promise<{ pair: string; setCookie: string }> => {
  const response = await post(server.app, '/api/invitations/passport', { token });
  expect(response.status).toBe(204);
  const setCookie = response.headers.getSetCookie()[0] ?? '';
  return { pair: cookiesFrom(response), setCookie };
};

const accountsAt = async (email: string): Promise<number> =>
  (
    await cloned.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .where('deleted_at', 'is', null)
      .execute()
  ).length;

const aNewPerson = (): ReturnType<typeof aGitHubPerson> =>
  aGitHubPerson(`pp-${crypto.randomUUID().slice(0, 8)}`);

/** The browser's whole GitHub round trip, carrying `cookie` to the start and so to the callback. */
const signInWith = async (
  server: Server,
  github: GitHubStub,
  cookie = '',
): Promise<string | null> => {
  const started = await startGitHubSignIn(server.app, ORIGIN, github, cookie);
  const back = await returnFromGitHub(server.app, ORIGIN, started);
  return back.headers.get('location');
};

const CLOSED = `${ORIGIN}/sign-in?error=signup-closed`;

/** The passports held under one digest — a cookie's or an address's — and nobody else's. */
const rowsFor = async (
  digest: string,
): Promise<
  {
    kind: string;
    cookie_digest: string | null;
    address_digest: string | null;
    consumed_at: Date | null;
  }[]
> =>
  await cloned.db
    .selectFrom('invitation_passports')
    .select(['kind', 'cookie_digest', 'address_digest', 'consumed_at'])
    .where((eb) => eb.or([eb('cookie_digest', '=', digest), eb('address_digest', '=', digest)]))
    .execute();

describe('integration: the passport route', () => {
  test('a github passport sets the cookie with its attributes, says 204, and stores a digest only', async () => {
    const person = aNewPerson();
    const server = aServer(aGitHubFor(person));
    const { token } = await anInvitation(server, 'pp-cookie');
    const response = await post(server.app, '/api/invitations/passport', { token });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const [setCookie] = response.headers.getSetCookie();
    const match = new RegExp(
      `^${INVITE_COOKIE}=([0-9a-f]{64}); HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=3600$`,
    ).exec(setCookie ?? '');
    expect(match).not.toBeNull();
    const value = match?.[1] ?? '';
    // At rest: the digest of the value, never the value or the token.
    const cookieDigest = await tokenDigest(value);
    const stored = await rowsFor(cookieDigest);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'github', address_digest: null, consumed_at: null });
    const dump = JSON.stringify(await sql`select * from invitation_passports`.execute(cloned.db));
    expect(dump).not.toContain(value);
    expect(dump).not.toContain(token);
  });

  test('an email passport sets no cookie and stores the digest of the lower-cased, trimmed address', async () => {
    const server = aServer(aGitHubFor(aNewPerson()));
    const { token } = await anInvitation(server, 'pp-email-rest');
    const address = `Mixed.Case-${crypto.randomUUID().slice(0, 6)}@Example.test`;
    const response = await post(server.app, '/api/invitations/passport', {
      token,
      email: address,
    });
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toEqual([]);
    const digest = await tokenDigest(normalisedMailbox(address) ?? '');
    const stored = await rowsFor(digest);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: 'email', cookie_digest: null });
    expect(
      JSON.stringify(await sql`select * from invitation_passports`.execute(cloned.db)),
    ).not.toContain(address.toLowerCase());
  });

  test('a link that does not open is the preview’s own 404, whichever way it fails', async () => {
    const server = aServer(aGitHubFor(aNewPerson()));
    const { owner, workspaceId, token } = await anInvitation(server, 'pp-dead');
    const asked = async (candidate: string): Promise<{ status: number; body: unknown }> => {
      const response = await post(server.app, '/api/invitations/passport', { token: candidate });
      const text = await response.text();
      return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
    };
    const preview = await post(
      server.app,
      '/api/invitations/preview',
      { token: 'a'.repeat(64) },
      { cookie: owner.cookie },
    );
    const expected = { status: preview.status, body: await preview.json() };
    expect(expected.status).toBe(404);

    // Unknown.
    expect(await asked('a'.repeat(64))).toEqual(expected);
    // Expired.
    await cloned.db
      .updateTable('workspace_invitations')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('token_hash', '=', await tokenDigest(token))
      .execute();
    // The server's clock is fixed at a date long before real time: expire it in its own terms too.
    await cloned.db
      .updateTable('workspace_invitations')
      .set({ expires_at: new Date(server.clock.now().getTime() - 1000), created_at: new Date(0) })
      .where('token_hash', '=', await tokenDigest(token))
      .execute();
    expect(await asked(token)).toEqual(expected);
    // Revoked.
    await cloned.db
      .updateTable('workspace_invitations')
      .set({
        expires_at: new Date(server.clock.now().getTime() + 24 * HOUR),
        revoked_at: new Date(),
      })
      .where('token_hash', '=', await tokenDigest(token))
      .execute();
    expect(await asked(token)).toEqual(expected);
    // Its workspace deleted.
    await cloned.db
      .updateTable('workspace_invitations')
      .set({ revoked_at: null })
      .where('token_hash', '=', await tokenDigest(token))
      .execute();
    expect((await asked(token)).status).toBe(204);
    await cloned.db
      .updateTable('workspaces')
      .set({ deleted_at: new Date() })
      .where('id', '=', workspaceId)
      .execute();
    expect(await asked(token)).toEqual(expected);
  });

  test('a body that is not strict JSON of the right shape is refused before any link is read', async () => {
    const server = aServer(aGitHubFor(aNewPerson()));
    for (const body of [
      {},
      { token: 'a'.repeat(63) },
      { token: 'a'.repeat(64), extra: true },
      { token: 'a'.repeat(64), email: 7 },
    ]) {
      const response = await post(server.app, '/api/invitations/passport', body);
      expect(response.status).toBe(400);
    }
    // A cross-origin post is the edge's refusal, not ours.
    const foreign = await post(
      server.app,
      '/api/invitations/passport',
      { token: 'a'.repeat(64) },
      { origin: 'https://evil.test' },
    );
    expect(foreign.status).toBe(403);
  });

  test('an address that is not one is refused for its shape, after the link is known to open', async () => {
    const server = aServer(aGitHubFor(aNewPerson()));
    const { token } = await anInvitation(server, 'pp-bad-address');
    const bad = await post(server.app, '/api/invitations/passport', { token, email: 'a@b.c' });
    expect(bad.status).toBe(400);
    // A bad address on a dead link is still the dead link's answer.
    const dead = await post(server.app, '/api/invitations/passport', {
      token: 'b'.repeat(64),
      email: 'a@b.c',
    });
    expect(await errorCode(dead)).toBe('INVITATION_NOT_FOUND');
  });

  test('the 21st live passport of one link is refused, and a spent one frees its place', async () => {
    const roomy = { perSecond: 1000, burst: 100_000 };
    const server = aServer(aGitHubFor(aNewPerson()), {
      overrides: {
        rateBudgets: {
          auth: AUTH_BUDGET,
          writes: WRITE_BUDGET,
          costlyReads: COSTLY_READ_BUDGET,
          passports: roomy,
        },
      },
    });
    const { token } = await anInvitation(server, 'pp-cap');
    const addresses: string[] = [];
    for (let made = 0; made < PASSPORTS_PER_INVITATION; made += 1) {
      const address = `cap-${String(made)}-${crypto.randomUUID().slice(0, 6)}@example.test`;
      addresses.push(address);
      const body = made % 2 === 0 ? { token, email: address } : { token };
      expect((await post(server.app, '/api/invitations/passport', body)).status).toBe(204);
    }
    const refused = await post(server.app, '/api/invitations/passport', { token });
    expect([refused.status, await errorCode(refused)]).toEqual([429, 'RATE_LIMITED']);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    const another = await post(server.app, '/api/invitations/passport', {
      token,
      email: 'one-more@example.test',
    });
    expect(another.status).toBe(429);
    // An address asking again for the same link replaces its own passport: not a 21st.
    const again = await post(server.app, '/api/invitations/passport', {
      token,
      email: addresses[0],
    });
    expect(again.status).toBe(204);
    // One passport past its hour is no longer live: its place is free.
    server.clock.advance(HOUR + 1000);
    expect((await post(server.app, '/api/invitations/passport', { token })).status).toBe(204);
  });

  test('the 11th request from one client in a quarter hour is 429 with Retry-After, the 31st too', async () => {
    const server = aServer(aGitHubFor(aNewPerson()));
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let asked = 0; asked < 31; asked += 1) {
      last = await post(server.app, '/api/invitations/passport', { token: 'c'.repeat(64) });
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 404)).toBe(true);
    expect(statuses.slice(10).every((status) => status === 429)).toBe(true);
    expect(Number(last?.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});

describe('integration: GitHub on an invite-only server', () => {
  test('without a passport a newcomer lands on signup-closed, and nothing is made', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github);
    expect(await signInWith(server, github)).toBe(CLOSED);
    expect(await accountsAt(person.email)).toBe(0);
  });

  test('with the passport’s cookie the account is made, the passport spent, and the cookie spends no second', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github);
    const { token } = await anInvitation(server, 'pp-gh');
    const { pair } = await aGitHubPassport(server, token);
    expect(await signInWith(server, github, pair)).toBe(ORIGIN);
    expect(await accountsAt(person.email)).toBe(1);
    const spent = await rowsFor(await tokenDigest(pair.split('=')[1] ?? ''));
    expect(spent.map((row) => row.consumed_at !== null)).toEqual([true]);

    // The same cookie, a different newcomer: refused.
    const other = aNewPerson();
    const otherGitHub = aGitHubFor(other);
    const second = aServer(otherGitHub);
    expect(await signInWith(second, otherGitHub, pair)).toBe(CLOSED);
    expect(await accountsAt(other.email)).toBe(0);
  });

  test('a cookie that is not a passport, or belongs to nothing, opens nothing', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github);
    expect(await signInWith(server, github, `${INVITE_COOKIE}=${'f'.repeat(64)}`)).toBe(CLOSED);
    expect(await signInWith(server, github, `${INVITE_COOKIE}=`)).toBe(CLOSED);
    expect(await accountsAt(person.email)).toBe(0);
  });

  test('a passport of an email address does not open a GitHub sign-up, and the reverse', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github);
    const { token } = await anInvitation(server, 'pp-kinds');
    // An email passport for the very address GitHub will give: no cookie, so nothing carried.
    await post(server.app, '/api/invitations/passport', { token, email: person.email });
    expect(await signInWith(server, github)).toBe(CLOSED);
    // A cookie's passport does not let that address in by an email link.
    await aGitHubPassport(server, token);
    await post(server.app, '/auth/email', { email: `other-${person.email}`, locale: 'en' });
    await server.app.settled();
    expect(server.mail.posted).toHaveLength(0);
  });

  test('a cookie from an invitation that was then revoked opens nothing', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github);
    const { token } = await anInvitation(server, 'pp-revoked');
    const { pair } = await aGitHubPassport(server, token);
    await cloned.db
      .updateTable('workspace_invitations')
      .set({ revoked_at: new Date() })
      .where('token_hash', '=', await tokenDigest(token))
      .execute();
    expect(await signInWith(server, github, pair)).toBe(CLOSED);
    expect(await accountsAt(person.email)).toBe(0);
  });

  test('a passport past its hour opens nothing', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github);
    const { token } = await anInvitation(server, 'pp-expired');
    const { pair } = await aGitHubPassport(server, token);
    server.clock.advance(HOUR + 1000);
    expect(await signInWith(server, github, pair)).toBe(CLOSED);
    expect(await accountsAt(person.email)).toBe(0);
  });

  test('two sign-ups at once with one cookie make exactly one account', async () => {
    const [first, second] = [aNewPerson(), aNewPerson()];
    const [githubOne, githubTwo] = [aGitHubFor(first), aGitHubFor(second)];
    const one = aServer(githubOne);
    const two = aServer(githubTwo);
    const { token } = await anInvitation(one, 'pp-race');
    const { pair } = await aGitHubPassport(one, token);
    const tabs = await Promise.all([
      startGitHubSignIn(one.app, ORIGIN, githubOne, pair),
      startGitHubSignIn(two.app, ORIGIN, githubTwo, pair),
    ]);
    await sql`
      create function hold_passport_window() returns trigger language plpgsql as
      $$ begin perform pg_sleep(0.3); return new; end $$
    `.execute(cloned.db);
    await sql`create trigger hold_passport before insert on users for each row execute function hold_passport_window()`.execute(
      cloned.db,
    );
    let answers: Response[];
    try {
      answers = await Promise.all([
        returnFromGitHub(one.app, ORIGIN, tabs[0]),
        returnFromGitHub(two.app, ORIGIN, tabs[1]),
      ]);
    } finally {
      await sql`drop trigger hold_passport on users`.execute(cloned.db);
      await sql`drop function hold_passport_window()`.execute(cloned.db);
    }
    expect(answers.map((answer) => answer.headers.get('location')).sort()).toEqual(
      [ORIGIN, CLOSED].sort(),
    );
    expect((await accountsAt(first.email)) + (await accountsAt(second.email))).toBe(1);
  });

  test('an account that is not made spends nothing: the same cookie makes it once the failure is gone', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github);
    const { token } = await anInvitation(server, 'pp-undone');
    const { pair } = await aGitHubPassport(server, token);
    await sql`
      create function refuse_passport_users() returns trigger language plpgsql as
      $$ begin raise exception 'refused by the test'; end $$
    `.execute(cloned.db);
    await sql`create trigger refuse_passport before insert on users for each row execute function refuse_passport_users()`.execute(
      cloned.db,
    );
    try {
      expect(await signInWith(server, github, pair)).toBe(`${ORIGIN}/sign-in?error=failed`);
    } finally {
      await sql`drop trigger refuse_passport on users`.execute(cloned.db);
      await sql`drop function refuse_passport_users()`.execute(cloned.db);
    }
    expect(await accountsAt(person.email)).toBe(0);
    // Spent inside the transaction that was undone, so not spent.
    const mine = await tokenDigest(pair.split('=')[1] ?? '');
    const theirs = await rowsFor(mine);
    expect(theirs.map((row) => row.consumed_at)).toEqual([null]);
    expect(await signInWith(server, github, pair)).toBe(ORIGIN);
    expect(await accountsAt(person.email)).toBe(1);
  });

  test('an existing account signs in with no passport', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github, { signUp: 'open' });
    expect(await signInWith(server, github)).toBe(ORIGIN);
    const closed = aServer(github);
    expect(await signInWith(closed, github)).toBe(ORIGIN);
    expect(await accountsAt(person.email)).toBe(1);
  });

  test('an open server needs no passport', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github, { signUp: 'open' });
    expect(await signInWith(server, github)).toBe(ORIGIN);
    expect(await accountsAt(person.email)).toBe(1);
  });

  test('the provider is never switched off on its own: the hook decides', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github);
    const { token } = await anInvitation(server, 'pp-provider');
    const { pair } = await aGitHubPassport(server, token);
    // Reaching the hook at all — and being let through by it — shows the provider did not refuse first.
    expect(await signInWith(server, github, pair)).toBe(ORIGIN);
  });
});

describe('integration: email on an invite-only server', () => {
  const askFor = async (server: Server, email: string): Promise<void> => {
    const response = await post(server.app, '/auth/email', { email, locale: 'en' });
    expect(response.status).toBe(202);
    await server.app.settled();
  };

  const tokenIn = (server: Server, to: string): string | undefined => {
    const letter = server.mail.posted.filter((message) => message.to === to).at(-1);
    return /#([0-9a-f]{64})/.exec(letter?.text ?? '')?.[1];
  };

  test('a passport for a@x lets a@x in by the mailed link and nobody else', async () => {
    const server = aServer(aGitHubFor(aNewPerson()));
    const { token } = await anInvitation(server, 'pp-mail');
    const a = `a-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const b = `b-${crypto.randomUUID().slice(0, 6)}@example.test`;
    expect((await post(server.app, '/api/invitations/passport', { token, email: a })).status).toBe(
      204,
    );

    await askFor(server, b);
    expect(tokenIn(server, b)).toBeUndefined();
    await askFor(server, a);
    const link = tokenIn(server, a);
    expect(link).toBeDefined();

    const preview = await post(server.app, '/auth/email/preview', { token: link });
    expect(await preview.json()).toEqual({ email: a });
    const consumed = await post(server.app, '/auth/email/consume', { token: link });
    expect(consumed.status).toBe(204);
    expect(consumed.headers.getSetCookie().length).toBeGreaterThan(0);
    expect(await accountsAt(a)).toBe(1);
    expect(await accountsAt(b)).toBe(0);
    const spent = await rowsFor(await tokenDigest(a));
    expect(spent.map((row) => row.consumed_at !== null)).toEqual([true]);

    // The passport is spent: another link to the same new address, were one made, opens no account —
    // and none is: nothing is mailed to an address with no live passport.
    await cloned.db.deleteFrom('users').where('email', '=', a).execute();
    await askFor(server, a);
    expect(server.mail.posted.filter((message) => message.to === a)).toHaveLength(1);
  });

  test('a link that was mailed makes no account if its passport is gone by the time it is spent', async () => {
    const server = aServer(aGitHubFor(aNewPerson()));
    const { token } = await anInvitation(server, 'pp-mail-gone');
    const a = `gone-${crypto.randomUUID().slice(0, 6)}@example.test`;
    await post(server.app, '/api/invitations/passport', { token, email: a });
    await askFor(server, a);
    const link = tokenIn(server, a);
    await cloned.db
      .updateTable('workspace_invitations')
      .set({ revoked_at: new Date() })
      .where('token_hash', '=', await tokenDigest(token))
      .execute();
    const consumed = await post(server.app, '/auth/email/consume', { token: link });
    expect([consumed.status, await errorCode(consumed)]).toEqual([404, 'SIGN_IN_LINK_NOT_FOUND']);
    expect(await accountsAt(a)).toBe(0);
  });

  test('a passport made while the link opened and spent after the passport’s hour is refused', async () => {
    const server = aServer(aGitHubFor(aNewPerson()));
    const { token } = await anInvitation(server, 'pp-mail-hour');
    const a = `hour-${crypto.randomUUID().slice(0, 6)}@example.test`;
    await post(server.app, '/api/invitations/passport', { token, email: a });
    await askFor(server, a);
    const link = tokenIn(server, a);
    server.clock.advance(HOUR + 1000);
    const consumed = await post(server.app, '/auth/email/consume', { token: link });
    expect(consumed.status).toBe(404);
    expect(await accountsAt(a)).toBe(0);
  });

  test('a passport for an address that already has an account is harmless and unspent by its sign-in', async () => {
    const server = aServer(aGitHubFor(aNewPerson()));
    const { token } = await anInvitation(server, 'pp-mail-existing');
    const c = `have-${crypto.randomUUID().slice(0, 6)}@example.test`;
    await cloned.db
      .insertInto('users')
      .values({
        email: c,
        username: `have-${crypto.randomUUID().slice(0, 6)}`,
        display_name: 'Have',
        email_verified: true,
      })
      .execute();
    expect((await post(server.app, '/api/invitations/passport', { token, email: c })).status).toBe(
      204,
    );
    await askFor(server, c);
    const link = tokenIn(server, c);
    expect(link).toBeDefined();
    expect((await post(server.app, '/auth/email/consume', { token: link })).status).toBe(204);
    expect(await accountsAt(c)).toBe(1);
    const digest = await tokenDigest(c);
    const mine = await rowsFor(digest);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.consumed_at).toBeNull();
  });

  test('an open server mails a newcomer with no passport', async () => {
    const server = aServer(aGitHubFor(aNewPerson()), { signUp: 'open' });
    const a = `open-${crypto.randomUUID().slice(0, 6)}@example.test`;
    await askFor(server, a);
    expect(tokenIn(server, a)).toBeDefined();
  });
});

describe('integration: what the passport does not touch', () => {
  test('the setup administrator is made on an invite-only server with no passport', async () => {
    // The administrator is made by `createAdmin` through the library's internal adapter, outside any
    // request: the hook sees no route, and decides nothing.
    const auth = aTestAuth(cloned.db, {
      settings: { github: undefined, oidc: undefined, signUp: 'invite-only' },
    });
    const context = await auth.$context;
    const user = await context.internalAdapter.createUser(
      {
        email: `admin-${crypto.randomUUID().slice(0, 6)}@example.test`,
        name: 'Admin',
        emailVerified: false,
      },
      { method: 'email-password' },
    );
    expect(user.id).toBeDefined();
  });

  test('no cookie value, address or token is written to a log line', async () => {
    const person = aNewPerson();
    const github = aGitHubFor(person);
    const server = aServer(github);
    const { token } = await anInvitation(server, 'pp-logs');
    const address = `logs-${crypto.randomUUID().slice(0, 6)}@example.test`;
    const { pair } = await aGitHubPassport(server, token);
    await post(server.app, '/api/invitations/passport', { token, email: address });
    await signInWith(server, github, pair);
    await signInWith(server, github, `${INVITE_COOKIE}=${'e'.repeat(64)}`);
    const written = JSON.stringify(server.logs.lines);
    const value = pair.split('=')[1] ?? '';
    expect(value).toHaveLength(64);
    for (const secret of [token, value, address, 'e'.repeat(64)]) {
      expect(written).not.toContain(secret);
    }
    // The control: the log did record the requests, so an empty log cannot pass for a clean one.
    expect(written).toContain('/api/invitations/passport');
  });
});

describe('integration: single sign-on on an invite-only server (D-200 §5)', () => {
  const CLOSED_OIDC = `${ORIGIN}/sign-in?error=signup-closed`;

  const aProviderServer = async (
    person: OidcPerson,
  ): Promise<{ readonly server: Server; readonly stub: OidcStub }> => {
    const clock = aMovableClock();
    // The provider tells time as the server does: a token is judged by the instance's own clock.
    const stub = await anOidcStub(person, {}, undefined, { now: () => clock.now().getTime() });
    const mail = aRecordingOutbox();
    const logs = aRecordingLogger();
    const app = createApp(
      testDependencies({
        database: cloned.db,
        clock,
        log: logs.log,
        mail,
        signUp: 'invite-only',
        auth: anOidcAuth(cloned.db, stub, {
          baseUrl: ORIGIN,
          signUp: 'invite-only',
          mailer: mail,
          clock,
          log: logs.log,
        }),
      }),
    );
    return { server: { app, clock, mail, logs }, stub };
  };

  const signInThrough = async (
    server: Server,
    stub: OidcStub,
    cookie = '',
  ): Promise<string | null> => {
    const started = await startOidcSignIn(server.app, ORIGIN, stub, cookie);
    const back = await returnFromOidc(server.app, ORIGIN, started);
    return back.headers.get('location');
  };

  test('without a passport a newcomer lands on signup-closed, and nothing is made', async () => {
    const person = aNewPerson();
    const { server, stub } = await aProviderServer({ sub: 'x1', email: person.email });
    expect(await signInThrough(server, stub)).toBe(CLOSED_OIDC);
    expect(await accountsAt(person.email)).toBe(0);
  });

  test('with the passport’s cookie the account is made and the passport spent, and the cookie spends no second', async () => {
    const person = aNewPerson();
    const { server, stub } = await aProviderServer({ sub: 'x2', email: person.email });
    const { token } = await anInvitation(server, 'pp-sso');
    const { pair } = await aGitHubPassport(server, token);
    expect(await signInThrough(server, stub, pair)).toBe(ORIGIN);
    expect(await accountsAt(person.email)).toBe(1);

    const other = aNewPerson();
    const second = await aProviderServer({ sub: 'x3', email: other.email });
    expect(await signInThrough(second.server, second.stub, pair)).toBe(CLOSED_OIDC);
    expect(await accountsAt(other.email)).toBe(0);
  });
});
