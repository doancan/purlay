/**
 * The setup's administrator (D-179 §4.3): made under a held claim, once, in one transaction — the
 * account through the sign-in library's own adapter, its address unverified, the server's authority on
 * it, a password the library hashed — and signed in with that password by the library itself.
 *
 * On a database of each test's own (`cloneIntegrationDatabase`): the library commits through its own
 * connection, and atomicity is only shown by a transaction that really rolls back.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { hashPassword } from 'better-auth/crypto';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sessionTokenDigest,
  sql,
  type Executor,
} from '@purlay/db';
import {
  DEVELOPMENT_ENCRYPTION_KEY,
  GITHUB_API_URL_DEFAULT,
  GITHUB_URL_DEFAULT,
} from '../../platform/config';
import { systemClock, type Clock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import { createLogger, type Logger } from '../../platform/logging';
import { SESSION_COOKIE } from '../../platform/cookies';
import { createAuth, deriveAuthSecret, type Auth } from '../auth/better-auth';
import { sessionFromHeaders } from '../auth/sessions';
import { aUserRow } from '../../testing/users';
import { AdminRefused, createAdmin, signInAdmin, type AdminRefusal } from './admin';
import {
  claimSetup,
  issueSetupCode,
  recordStep,
  requireSetupClaim,
  SetupRefused,
  type SetupRefusal,
  type SetupClaimDigest,
  type SetupSession,
} from './setup';

type KyselyPlugin = Parameters<Executor['withPlugin']>[0];

const clones: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(
    clones.map(async (drop) => {
      await drop();
    }),
  );
  await closeIntegrationDatabase();
});

const BASE = 'https://purlay.example.com';
const silent = createLogger({ level: 'silent' });

const nobodyListening: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => true,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

const authOver = (database: Executor, clock: Clock = systemClock): Auth =>
  createAuth({
    database,
    baseUrl: BASE,
    secret: deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY),
    log: silent,
    settings: { github: undefined, oidc: undefined, signUp: 'invite-only' },
    githubUrls: { web: GITHUB_URL_DEFAULT, api: GITHUB_API_URL_DEFAULT },
    sessionTtlDays: 30,
    bus: nobodyListening,
    clock,
  });

/** A log that keeps its lines, so the setup code can be read back as an operator reads it. */
const recording = (): { log: Logger; lines: string[] } => {
  const lines: string[] = [];
  return { log: createLogger({ level: 'debug', write: (line) => lines.push(line) }), lines };
};

/** A fresh server, its setup claimed by this browser: the session every later step is guarded by. */
const aClaimedServer = async (
  plugin?: KyselyPlugin,
): Promise<{ db: Executor; plain: Executor; session: SetupSession; auth: Auth }> => {
  const clone = await cloneIntegrationDatabase();
  clones.push(clone.drop);
  const db = plugin === undefined ? clone.db : clone.db.withPlugin(plugin);
  const { log, lines } = recording();
  await issueSetupCode(clone.db, log, systemClock);
  const code = lines
    .map((line) => JSON.parse(line) as { setupCode?: unknown })
    .map((line) => line.setupCode)
    .find((value): value is string => typeof value === 'string');
  if (code === undefined) throw new Error('no setup code was written');
  const { claimToken } = await claimSetup(clone.db, code, 'browser-1', systemClock);
  const session = await requireSetupClaim(clone.db, claimToken, systemClock);
  return { db, plain: clone.db, session, auth: authOver(db) };
};

const ADA = {
  name: '  Ada Lovelace  ',
  email: ' Ada@Example.COM ',
  password: 'analytical engine 1843',
};

const adminRefusal = async (promise: Promise<unknown>): Promise<AdminRefusal | SetupRefusal> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdminRefused) return error.refusal;
    if (error instanceof SetupRefused) return error.refusal;
    throw error;
  }
  throw new Error('expected a refusal');
};

const everything = async (
  db: Executor,
): Promise<{ users: number; accounts: number; admin: string | null; step: string | null }> => {
  const { rows } = await sql<{
    users: number;
    accounts: number;
    admin: string | null;
    step: string | null;
  }>`
    select (select count(*)::int from users) as users,
           (select count(*)::int from accounts) as accounts,
           (select admin_user_id from setup_state) as admin,
           (select step_reached from setup_state) as step`.execute(db);
  const row = rows[0];
  if (row === undefined) throw new Error('no state');
  return row;
};

describe('integration: the setup’s administrator (D-179 §4.3)', () => {
  test('is made with its address unverified, the server’s authority, a hashed password, and the step recorded', async () => {
    const { db, session, auth } = await aClaimedServer();
    const made = await createAdmin({ database: db, auth, clock: systemClock }, session, ADA);
    // Nothing but the id comes back: no hash, no row.
    expect(Object.keys(made)).toEqual(['userId']);

    const user = await db
      .selectFrom('users')
      .select(['id', 'email', 'email_verified', 'is_server_admin', 'display_name', 'username'])
      .where('id', '=', made.userId)
      .executeTakeFirstOrThrow();
    expect(user).toEqual({
      id: made.userId,
      email: 'ada@example.com',
      email_verified: false,
      is_server_admin: true,
      display_name: 'Ada Lovelace',
      username: 'ada',
    });

    const accounts = await db
      .selectFrom('accounts')
      .select(['provider_id', 'account_id', 'password'])
      .where('user_id', '=', made.userId)
      .execute();
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.provider_id).toBe('credential');
    expect(accounts[0]?.account_id).toBe(made.userId);
    const hash = accounts[0]?.password ?? '';
    expect(hash).not.toContain(ADA.password);
    // The library's own scrypt: salt and key, hex, colon between.
    expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    const { verify } = (await auth.$context).password;
    expect(await verify({ hash, password: ADA.password })).toBe(true);

    expect(await everything(db)).toMatchObject({ admin: made.userId, step: 'admin', users: 1 });
  });

  test('needs the claim this browser holds: a session whose claim was taken over is refused, nothing made', async () => {
    const { db, session, auth } = await aClaimedServer();
    const stranger: SetupClaimDigest = { claimDigest: 'f'.repeat(64) };
    // The hash is the slow part: a request without the claim never reaches it.
    const { password } = await auth.$context;
    const hash = password.hash;
    let hashed = 0;
    password.hash = async (plain: string): Promise<string> => {
      hashed += 1;
      return await hash(plain);
    };
    expect(
      await adminRefusal(createAdmin({ database: db, auth, clock: systemClock }, stranger, ADA)),
    ).toEqual({
      reason: 'not-claimed',
    });
    expect(await everything(db)).toMatchObject({
      users: 0,
      accounts: 0,
      admin: null,
      step: 'claim',
    });
    expect(hashed).toBe(0);
    // The real one still can.
    await createAdmin({ database: db, auth, clock: systemClock }, session, ADA);
  });

  test('is the step after the claim: a setup recorded past it without an administrator is out of order', async () => {
    const { db, session, auth } = await aClaimedServer();
    await recordStep(db, session, 'admin', systemClock);
    expect(
      await adminRefusal(createAdmin({ database: db, auth, clock: systemClock }, session, ADA)),
    ).toEqual({
      reason: 'out-of-order',
    });
    expect(await everything(db)).toMatchObject({ users: 0, accounts: 0, admin: null });
  });

  test('is made once: a second, under the same claim and with another address, is refused as admin-exists', async () => {
    const { db, session, auth } = await aClaimedServer();
    const first = await createAdmin({ database: db, auth, clock: systemClock }, session, ADA);
    expect(
      await adminRefusal(
        createAdmin({ database: db, auth, clock: systemClock }, session, {
          name: 'Grace Hopper',
          email: 'grace@example.com',
          password: 'compiler of 1952 a0',
        }),
      ),
    ).toEqual({ reason: 'admin-exists' });
    expect(await everything(db)).toMatchObject({ users: 1, accounts: 1, admin: first.userId });
  });

  test('two at once make one administrator', async () => {
    const { db, session, auth } = await aClaimedServer();
    const outcomes = await Promise.allSettled([
      createAdmin({ database: db, auth, clock: systemClock }, session, ADA),
      createAdmin({ database: db, auth, clock: systemClock }, session, {
        ...ADA,
        email: 'other@example.com',
      }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await everything(db)).toMatchObject({ users: 1, accounts: 1 });
  });

  test('is atomic: a failure after the account is written leaves no user, no password, no administrator', async () => {
    let failing = true;
    const failingAccounts: KyselyPlugin = {
      transformQuery: (args): ReturnType<KyselyPlugin['transformQuery']> => {
        if (
          failing &&
          args.node.kind === 'InsertQueryNode' &&
          JSON.stringify(args.node.into).includes('"accounts"')
        ) {
          throw new Error('the account could not be written');
        }
        return args.node;
      },
      transformResult: async (args) => await Promise.resolve(args.result),
    };
    const { db, plain, session, auth } = await aClaimedServer(failingAccounts);
    const failed = await createAdmin({ database: db, auth, clock: systemClock }, session, ADA).then(
      () => 'made',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(failed).toBe('the account could not be written');
    expect(await everything(plain)).toEqual({ users: 0, accounts: 0, admin: null, step: 'claim' });
    // Nothing half-made stands in the way of trying again.
    failing = false;
    const made = await createAdmin({ database: db, auth, clock: systemClock }, session, ADA);
    expect(await everything(plain)).toMatchObject({ users: 1, accounts: 1, admin: made.userId });
  });

  /** A statement of the transaction refused, before it runs or once it has: the query it is, by a test. */
  const failingAt = (
    matches: (node: unknown) => boolean,
    when: 'before' | 'after',
  ): { plugin: KyselyPlugin; stop: () => void } => {
    let failing = true;
    let ran = false;
    return {
      stop: (): void => {
        failing = false;
      },
      plugin: {
        transformQuery: (args): ReturnType<KyselyPlugin['transformQuery']> => {
          if (failing && matches(args.node)) {
            if (when === 'before') throw new Error('injected');
            ran = true;
          }
          return args.node;
        },
        transformResult: async (args): ReturnType<KyselyPlugin['transformResult']> => {
          if (ran) {
            ran = false;
            throw new Error('injected');
          }
          return await Promise.resolve(args.result);
        },
      },
    };
  };

  const isUpdateOf =
    (table: string, column: string) =>
    (node: unknown): boolean => {
      const text = JSON.stringify(node);
      return (
        (node as { kind?: unknown }).kind === 'UpdateQueryNode' &&
        text.includes(`"${table}"`) &&
        text.includes(`"${column}"`)
      );
    };

  for (const [where, matches, when] of [
    [
      'the server’s authority, after the user is inserted',
      isUpdateOf('users', 'is_server_admin'),
      'before',
    ],
    ['the setup’s row', isUpdateOf('setup_state', 'admin_user_id'), 'before'],
    ['after the setup’s row is written', isUpdateOf('setup_state', 'admin_user_id'), 'after'],
  ] as const) {
    test(`is atomic: a failure at ${where} leaves no user, no password, no administrator`, async () => {
      const injected = failingAt(matches, when);
      const { db, plain, session, auth } = await aClaimedServer(injected.plugin);
      const failed = await createAdmin(
        { database: db, auth, clock: systemClock },
        session,
        ADA,
      ).then(
        () => 'made',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(failed).toBe('injected');
      expect(await everything(plain)).toEqual({
        users: 0,
        accounts: 0,
        admin: null,
        step: 'claim',
      });
      injected.stop();
      const made = await createAdmin({ database: db, auth, clock: systemClock }, session, ADA);
      expect(await everything(plain)).toMatchObject({ users: 1, accounts: 1, admin: made.userId });
    });
  }

  test('refuses what is not an address, a name, or a password the policy allows — before anything is written', async () => {
    const { db, session, auth } = await aClaimedServer();
    const cases: readonly (readonly [Partial<typeof ADA>, AdminRefusal])[] = [
      [{ email: 'not an address' }, { reason: 'invalid-email' }],
      [{ email: 'x<ada@example.com>' }, { reason: 'invalid-email' }],
      [{ name: '' }, { reason: 'invalid-name' }],
      [{ name: '   ' }, { reason: 'invalid-name' }],
      [{ name: 'a'.repeat(129) }, { reason: 'invalid-name' }],
      [{ name: 'Ada\u0000Lovelace' }, { reason: 'invalid-name' }],
      [{ name: 'Ada‮Lovelace' }, { reason: 'invalid-name' }],
      [{ name: 'Ada\u2066Lovelace' }, { reason: 'invalid-name' }],
      [{ name: 'Ada\u2028Lovelace' }, { reason: 'invalid-name' }],
      [{ password: 'too short' }, { reason: 'weak-password', problem: 'too-short' }],
      [{ password: 'x'.repeat(129) }, { reason: 'weak-password', problem: 'too-long' }],
      [{ password: 'ada@example.com!!' }, { reason: 'weak-password', problem: 'contains-email' }],
      [{ password: 'i am ada lovelace' }, { reason: 'weak-password', problem: 'contains-name' }],
      [{ password: 'Password123' }, { reason: 'weak-password', problem: 'common' }],
    ];
    for (const [change, refusal] of cases) {
      expect(
        await adminRefusal(
          createAdmin({ database: db, auth, clock: systemClock }, session, { ...ADA, ...change }),
        ),
      ).toEqual(refusal);
    }
    expect(await everything(db)).toMatchObject({
      users: 0,
      accounts: 0,
      admin: null,
      step: 'claim',
    });
    // A name of exactly 128 characters is one.
    await createAdmin({ database: db, auth, clock: systemClock }, session, {
      ...ADA,
      name: 'é'.repeat(128),
    });
  });

  test("takes a name a workspace could take: a right-to-left one with its direction mark (the 'name' format's rule)", async () => {
    const { db, session, auth } = await aClaimedServer();
    const made = await createAdmin({ database: db, auth, clock: systemClock }, session, {
      ...ADA,
      name: '\u200Fעדה לאבלייס',
    });
    const row = await db
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', made.userId)
      .executeTakeFirstOrThrow();
    expect(row.display_name).toBe('\u200Fעדה לאבלייס');
  });

  test('an address an account already has is refused as email-taken, and nothing is made', async () => {
    const { db, session, auth } = await aClaimedServer();
    // An account that arrived during the setup (Ruling R42): the holder may still go on.
    const other = await aUserRow(db, 'early');
    expect(
      await adminRefusal(
        createAdmin({ database: db, auth, clock: systemClock }, session, {
          ...ADA,
          email: other.email.toUpperCase(),
        }),
      ),
    ).toEqual({ reason: 'email-taken' });
    expect(await everything(db)).toMatchObject({
      users: 1,
      accounts: 0,
      admin: null,
      step: 'claim',
    });
  });
});

describe('integration: the administrator signs in with the password (D-179 §4.3)', () => {
  test('at once, unverified as the address is: a session of the library’s, real and hashed at rest', async () => {
    const { db, session, auth } = await aClaimedServer();
    const made = await createAdmin({ database: db, auth, clock: systemClock }, session, ADA);
    const answered = await signInAdmin(auth, {
      email: ADA.email,
      password: ADA.password,
      clientAddress: '203.0.113.7',
    });
    expect(answered.status).toBe(200);
    const text = await answered.clone().text();
    expect(text).not.toContain(ADA.password);
    expect(text).not.toMatch(/[0-9a-f]{32}:[0-9a-f]{128}/);
    const cookie = answered.headers
      .getSetCookie()
      .find((line) => line.startsWith(`${SESSION_COOKIE}=`));
    expect(cookie).toBeDefined();
    const pair = (cookie ?? '').split(';')[0] ?? '';
    const owner = await sessionFromHeaders(auth, new Headers({ cookie: pair }));
    expect(owner?.userId).toBe(made.userId);

    // At rest, the row holds the token's digest and never the token the cookie carries.
    const raw = decodeURIComponent(pair.slice(SESSION_COOKIE.length + 1)).split('.')[0] ?? '';
    const rows = await db
      .selectFrom('sessions')
      .select('token_hash')
      .where('user_id', '=', made.userId)
      .execute();
    expect(rows).toEqual([{ token_hash: sessionTokenDigest(raw) }]);
    expect(rows[0]?.token_hash).not.toBe(raw);
  });

  test('a wrong password does not sign in', async () => {
    const { db, session, auth } = await aClaimedServer();
    await createAdmin({ database: db, auth, clock: systemClock }, session, ADA);
    const answered = await signInAdmin(auth, {
      email: ADA.email,
      password: 'not the password at all',
      clientAddress: '203.0.113.8',
    });
    expect(answered.status).toBe(401);
    expect(
      answered.headers.getSetCookie().some((line) => line.startsWith(`${SESSION_COOKIE}=`)),
    ).toBe(false);
  });

  test('a credential row written as the reset command writes it — provider credential, account id the user id, the library’s scrypt — is accepted', async () => {
    const { db, auth } = await aClaimedServer();
    const user = await aUserRow(db, 'cli');
    await db
      .insertInto('accounts')
      .values({
        user_id: user.userId,
        provider_id: 'credential',
        account_id: user.userId,
        password: await hashPassword('reset on the server 2026'),
      })
      .execute();
    const answered = await signInAdmin(auth, {
      email: user.email,
      password: 'reset on the server 2026',
      clientAddress: '203.0.113.9',
    });
    expect(answered.status).toBe(200);
  });
});
