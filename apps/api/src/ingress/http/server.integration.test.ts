/**
 * Administration → Server over HTTP (D-179 §4.8, `API.md` §2 `/api/server/*`): the real mounted
 * application on a database of each test's own, its sign-in services held by the holder the composition
 * root uses, GitHub the strict stand-in on a loopback port and the relay a scripted one — so a change
 * that is kept really swaps what serves, and a refusal really reaches nothing.
 *
 * What is held here: only the server's administrator gets anything (a member, a workspace's owner, a
 * signed-out caller and a stale cookie get one identical answer, and nothing is tried for them); a try
 * comes before any save; the last way in is not removed by accident, even by two requests at once; the
 * policy and the creators take effect on the next request; every change is on the trail without its
 * value; no secret is in any answer or any line written; and a client is limited.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type Executor,
  DROP_HOOK_MS,
} from '@purlay/db';
import {
  OIDC_CALLBACK,
  SIGN_IN_CALLBACK,
  type MeResponse,
  type ServerSettingsAnswer,
} from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { systemClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import {
  DEVELOPMENT_ENCRYPTION_KEY,
  GITHUB_API_URL_DEFAULT,
  GITHUB_URL_DEFAULT,
} from '../../platform/config';
import { credentialCipher } from '../../platform/crypto';
import { NO_LOG } from '../../platform/events';
import { createLogger, type Logger } from '../../platform/logging';
import { deriveAuthSecret } from '../../modules/auth/better-auth';
import { createWorkspace } from '../../modules/workspaces/workspaces';
import { atomicallyOn } from '../../platform/transactions';
import { inProcessEventBus } from '../../realtime/bus';
import type { RateBudget } from '../../realtime/rate-limiter';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aGitHubPerson, signInWithGitHub } from '../../testing/github-sign-in';
import { aGitHubStub, GITHUB_STUB_CREDENTIALS, type GitHubStub } from '../../testing/github-stub';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import {
  anOidcStub,
  OIDC_STUB_CREDENTIALS,
  type OidcBehaviour,
  type OidcStub,
} from '../../testing/oidc-stub';
import { aScriptedRelay, type ScriptedRelay } from '../../testing/smtp-relay';
import { aUniqueSlug } from '../../testing/users';
import {
  readSettings,
  readSettingsToBoot,
  readWorkspaceCreators,
  saveSettings,
} from '../../modules/setup/settings';
import {
  runtimeServicesFrom,
  runtimeServicesHolder,
  type RuntimeHolder,
  type SettingsChange,
} from '../../modules/setup/runtime';
import { SERVER_ADMIN_BUDGET } from './rate-limit';

const ORIGIN = 'https://purlay.test';
const cipher = credentialCipher(DEVELOPMENT_ENCRYPTION_KEY);
const ROOMY: RateBudget = { perSecond: 1000, burst: 100_000 };
const RELAY_USER = 'mailer';
const RELAY_PASS = 'relay-pass-7311';
const BAD_SECRET = 'not-the-secret-4417';

const clones: (() => Promise<void>)[] = [];
const stops: (() => unknown)[] = [];
// Every test's database, dropped after its connections have closed: up to 31 of them, which fitted the
// five seconds a hook is given only on an idle machine (#797, D-228).
afterAll(async () => {
  for (const stop of stops) await stop();
  await Promise.all(
    clones.map(async (drop) => {
      await drop();
    }),
  );
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

/** Every line the server writes, raw, as the operator's terminal would show it. */
const recording = (): { log: Logger; lines: string[] } => {
  const lines: string[] = [];
  return {
    log: createLogger({
      level: 'debug',
      write: (line) => {
        lines.push(line);
      },
    }),
    lines,
  };
};

interface Server {
  readonly app: HttpApplication;
  readonly db: Executor;
  readonly holder: RuntimeHolder;
  readonly lines: string[];
  readonly github: GitHubStub;
  readonly person: ReturnType<typeof aGitHubPerson>;
  readonly admin: SignedInUser;
  readonly member: SignedInUser;
  /** An owner of a workspace: not the server's administrator. */
  readonly owner: SignedInUser;
}

const aServer = async (
  options: {
    readonly limits?: 'real';
    readonly noWorkspace?: boolean;
    /** A GitHub app sealed under another key before the start: read as unset, needing entry again. */
    readonly unreadableGitHub?: boolean;
  } = {},
): Promise<Server> => {
  const cloned = await cloneIntegrationDatabase();
  clones.push(cloned.drop);
  const person = aGitHubPerson();
  const github = aGitHubStub(person);
  const served = github.serve(0);
  stops.push(served.stop);
  const { log, lines } = recording();
  const holder = runtimeServicesHolder(log);
  const build: SettingsChange['build'] = (settings, needsReentry) =>
    runtimeServicesFrom(
      settings,
      {
        database: cloned.db,
        baseUrl: ORIGIN,
        secret: deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY),
        log,
        // The sign-in library's own door is the stub's `fetch` at GitHub's real addresses; the probes
        // take the configuration's, which is the stub served on a port.
        githubUrls: { web: GITHUB_URL_DEFAULT, api: GITHUB_API_URL_DEFAULT },
        // GitHub's two addresses are the stand-in; a single sign-on provider is a server on a loopback port.
        fetch: async (url, init) =>
          url.startsWith(GITHUB_URL_DEFAULT) || url.startsWith(GITHUB_API_URL_DEFAULT)
            ? await github.fetch(url, init)
            : await fetch(url, init),
        sessionTtlDays: 30,
        bus: inProcessEventBus(() => undefined, NO_LOG),
        clock: systemClock,
      },
      needsReentry,
      holder.sends,
    );
  const admin = await aSignedInUser(cloned.db, systemClock, 'srv-admin');
  await cloned.db
    .updateTable('users')
    .set({ is_server_admin: true })
    .where('id', '=', admin.userId)
    .execute();
  const member = await aSignedInUser(cloned.db, systemClock, 'srv-member');
  const owner = await aSignedInUser(cloned.db, systemClock, 'srv-owner');
  if (options.noWorkspace !== true) {
    await atomicallyOn(cloned.db)(
      async (transaction) =>
        await createWorkspace(transaction, systemClock, owner.userId, {
          name: 'Owned',
          slug: aUniqueSlug('owned'),
        }),
    );
  }
  if (options.unreadableGitHub === true) {
    await saveSettings(
      cloned.db,
      credentialCipher('a-different-key-of-the-right-shape-0123456789abcdef'),
      systemClock,
      { github: GITHUB_STUB_CREDENTIALS },
    );
  }
  const boot = await readSettingsToBoot(cloned.db, cipher);
  holder.settle(build(boot.settings, boot.needsReentry));
  const app = createApp(
    testDependencies({
      database: cloned.db,
      config: testConfig({
        APP_URL: ORIGIN,
        TRUST_PROXY: true,
        GITHUB_URL: served.url,
        GITHUB_API_URL: served.url,
      }),
      clock: systemClock,
      log,
      auth: holder.auth,
      services: holder,
      workspaceCreators: readWorkspaceCreators,
      settingsChange: { holder, cipher, clock: systemClock, log, build },
      rateBudgets:
        options.limits === 'real'
          ? {
              auth: ROOMY,
              writes: ROOMY,
              costlyReads: ROOMY,
              setup: ROOMY,
              setupSecrets: ROOMY,
              serverAdmin: SERVER_ADMIN_BUDGET,
            }
          : {
              auth: ROOMY,
              writes: ROOMY,
              costlyReads: ROOMY,
              setup: ROOMY,
              setupSecrets: ROOMY,
              serverAdmin: ROOMY,
            },
    }),
  );
  return { app, db: cloned.db, holder, lines, github, person, admin, member, owner };
};

interface Call {
  readonly body?: unknown;
  readonly cookie?: string | undefined;
  readonly client?: string;
  readonly origin?: string;
}

const call = async (
  server: Server,
  method: 'GET' | 'HEAD' | 'POST' | 'DELETE',
  path: string,
  { body, cookie, client = '203.0.113.7', origin = ORIGIN }: Call = {},
): Promise<Response> =>
  await server.app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'POST' || method === 'DELETE' ? { origin } : {}),
        ...(cookie === undefined ? {} : { cookie }),
        'x-forwarded-for': client,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

const viewOf = async (server: Server): Promise<ServerSettingsAnswer> => {
  const response = await call(server, 'GET', '/api/server/settings', {
    cookie: server.admin.cookie,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ServerSettingsAnswer;
};

const aRelay = async (): Promise<ScriptedRelay> => {
  const relay = await aScriptedRelay({ login: { user: RELAY_USER, pass: RELAY_PASS } });
  stops.push(relay.stop);
  return relay;
};

const smtpBody = (relay: ScriptedRelay, pass = RELAY_PASS): Record<string, unknown> => ({
  smtpUrl: `smtp://${RELAY_USER}:${pass}@127.0.0.1:${String(relay.port)}`,
  from: 'purlay@example.test',
  allowPlaintext: false,
});

const trail = async (
  server: Server,
): Promise<{ action: string; actor: string | null; session: string | null }[]> =>
  (
    await server.db
      .selectFrom('server_audit_log')
      .select(['action', 'actor_user_id', 'session_id'])
      .where('actor_user_id', 'is not distinct from', server.admin.userId)
      .orderBy('id')
      .execute()
  ).map((row) => ({ action: row.action, actor: row.actor_user_id, session: row.session_id }));

const GITHUB_OK = { ...GITHUB_STUB_CREDENTIALS };
const GITHUB_BAD = { clientId: GITHUB_STUB_CREDENTIALS.clientId, clientSecret: BAD_SECRET };

/** Every route, each with a body it would accept. */
const ROUTES: readonly [method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown][] = [
  ['GET', '/api/server/settings', undefined],
  ['POST', '/api/server/github', GITHUB_OK],
  [
    'POST',
    '/api/server/smtp',
    { smtpUrl: 'smtp://m:p@127.0.0.1:1', from: 'a@example.test', allowPlaintext: false },
  ],
  ['POST', '/api/server/oidc', { issuer: 'https://idp.example.test', ...OIDC_STUB_CREDENTIALS }],
  ['DELETE', '/api/server/github', undefined],
  ['DELETE', '/api/server/smtp', undefined],
  ['DELETE', '/api/server/oidc', undefined],
  ['POST', '/api/server/policy', { signUp: 'open' }],
  ['POST', '/api/server/policy', { requireTwoFactor: true }],
  ['POST', '/api/server/policy', { passwordSignIn: false }],
  ['POST', '/api/server/creators', { workspaceCreators: { kind: 'anyone' } }],
];

const NOT_FOUND = { error: { code: 'ROUTE_NOT_FOUND', message: 'No such route.' } };

const comparable = (response: Response): Record<string, string> =>
  Object.fromEntries([...response.headers.entries()].filter(([name]) => name !== 'x-request-id'));

describe('integration: Administration → Server', () => {
  test('everybody but the server administrator gets one answer on every route, and nothing is tried for them', async () => {
    const server = await aServer();
    const relay = await aRelay();
    const demoted = await aSignedInUser(server.db, systemClock, 'srv-demoted');
    const erased = await aSignedInUser(server.db, systemClock, 'srv-erased');
    await server.db
      .updateTable('users')
      .set({ is_server_admin: true, deleted_at: new Date() })
      .where('id', '=', erased.userId)
      .execute();
    const callers: [string, string | undefined][] = [
      ['signed out', undefined],
      ['a stale cookie', `${SESSION_COOKIE}=${'a'.repeat(40)}`],
      ['a member', server.member.cookie],
      ['a workspace owner', server.owner.cookie],
      ['an administrator who was never promoted', demoted.cookie],
      ['an administrator erased', erased.cookie],
    ];
    let reference: Record<string, string> | undefined;
    for (const [method, path, body] of ROUTES) {
      for (const [who, cookie] of callers) {
        const response = await call(server, method, path, {
          ...(cookie === undefined ? {} : { cookie }),
          ...(body === undefined
            ? {}
            : { body: path === '/api/server/smtp' ? smtpBody(relay) : body }),
        });
        expect([who, method, path, response.status]).toEqual([who, method, path, 404]);
        expect(await response.json()).toEqual(NOT_FOUND);
        reference ??= comparable(response);
        expect(comparable(response)).toEqual(reference);
      }
    }
    // Nothing was tried, saved or sent for any of them.
    expect(server.github.presentedCodes).toHaveLength(0);
    expect(relay.commands).toHaveLength(0);
    expect((await readSettings(server.db, cipher)).github).toBeUndefined();
    expect(await trail(server)).toEqual([]);
  });

  test('the administrator is read from the database each request: demoted, the page is gone at once', async () => {
    const server = await aServer();
    expect(
      (await call(server, 'GET', '/api/server/settings', { cookie: server.admin.cookie })).status,
    ).toBe(200);
    await server.db
      .updateTable('users')
      .set({ is_server_admin: false })
      .where('id', '=', server.admin.userId)
      .execute();
    expect(
      (await call(server, 'GET', '/api/server/settings', { cookie: server.admin.cookie })).status,
    ).toBe(404);
  });

  test('GET /api/me says who is the administrator, and a workspace owner is not', async () => {
    const server = await aServer();
    const meOf = async (user: SignedInUser): Promise<MeResponse> =>
      (await (await call(server, 'GET', '/api/me', { cookie: user.cookie })).json()) as MeResponse;
    expect((await meOf(server.admin)).isServerAdmin).toBe(true);
    expect((await meOf(server.member)).isServerAdmin).toBe(false);
    expect((await meOf(server.owner)).isServerAdmin).toBe(false);
  });

  test('the view: nothing connected, the addresses to paste, the caller’s own address — and no secret once connected', async () => {
    const server = await aServer();
    const empty = await viewOf(server);
    expect(empty).toEqual({
      settings: {
        signUp: 'invite-only',
        github: null,
        oidc: null,
        smtp: null,
        workspaceCreators: { kind: 'first' },
        setupCompletedAt: null,
        requireTwoFactor: false,
        passwordSignIn: true,
      },
      needsReentry: [],
      appUrl: ORIGIN,
      githubCallbackUrl: `${ORIGIN}${SIGN_IN_CALLBACK}`,
      oidcCallbackUrl: `${ORIGIN}${OIDC_CALLBACK}`,
      channels: { github: false, email: false, oidc: false },
      adminEmail: server.admin.email,
    });
    const relay = await aRelay();
    expect(
      (
        await call(server, 'POST', '/api/server/github', {
          cookie: server.admin.cookie,
          body: GITHUB_OK,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(server, 'POST', '/api/server/smtp', {
          cookie: server.admin.cookie,
          body: smtpBody(relay),
        })
      ).status,
    ).toBe(200);
    const connected = await viewOf(server);
    expect(connected.settings.github).toEqual({
      clientId: GITHUB_OK.clientId,
      clientSecret: { set: true },
    });
    expect(connected.settings.smtp).toEqual({
      address: { set: true, host: `smtp://127.0.0.1:${String(relay.port)}` },
      from: 'purlay@example.test',
      allowPlaintext: false,
    });
    expect(connected.channels).toEqual({ github: true, email: true, oidc: false });
    const text = JSON.stringify(connected);
    for (const secret of [GITHUB_OK.clientSecret, RELAY_PASS, RELAY_USER]) {
      expect(text).not.toContain(secret);
    }
  });

  test('a secret that cannot be opened is said to need entering again', async () => {
    const server = await aServer();
    await saveSettings(server.db, cipher, systemClock, { github: GITHUB_OK });
    // The boot of a process whose key was rotated: the ciphertext does not open, and is served as unset.
    const rotated = credentialCipher('a-different-key-of-the-right-shape-0123456789abcdef');
    const boot = await readSettingsToBoot(server.db, rotated);
    expect(boot.needsReentry).toEqual(['github']);
  });

  test('GitHub is tried before it is saved: a bad pair saves nothing, a good one is kept and serves', async () => {
    const server = await aServer();
    const bad = await call(server, 'POST', '/api/server/github', {
      cookie: server.admin.cookie,
      body: GITHUB_BAD,
    });
    expect(bad.status).toBe(200);
    const refused = (await bad.json()) as { ok: boolean; reason?: string; raw?: string };
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('secret-rejected');
    expect(JSON.stringify(refused)).not.toContain(BAD_SECRET);
    expect((await readSettings(server.db, cipher)).github).toBeUndefined();
    expect((await call(server, 'GET', '/auth/github')).status).toBe(404);
    expect(await trail(server)).toEqual([]);

    const good = await call(server, 'POST', '/api/server/github', {
      cookie: server.admin.cookie,
      body: GITHUB_OK,
    });
    expect([good.status, await good.json()]).toEqual([200, { ok: true }]);
    expect((await readSettings(server.db, cipher)).github).toEqual(GITHUB_OK);
    const start = await call(server, 'GET', '/auth/github');
    expect(start.status).toBe(302);
    expect(new URL(start.headers.get('location') ?? '').searchParams.get('client_id')).toBe(
      GITHUB_OK.clientId,
    );
    const methods = (await (await call(server, 'GET', '/api/auth/methods')).json()) as {
      github: boolean;
    };
    expect(methods.github).toBe(true);
    expect((await trail(server)).map((row) => row.action)).toEqual(['server.github_connected']);
  });

  test('a body that is not the contract is refused before anything is tried', async () => {
    const server = await aServer();
    for (const body of [
      {},
      { clientId: 'x' },
      { clientId: '', clientSecret: 'y' },
      { ...GITHUB_OK, extra: 1 },
    ]) {
      const response = await call(server, 'POST', '/api/server/github', {
        cookie: server.admin.cookie,
        body,
      });
      expect(response.status).toBe(400);
    }
    expect(server.github.presentedCodes).toHaveLength(0);
  });

  test('the relay is tried with a test letter to the administrator, and kept only if it took it', async () => {
    const server = await aServer();
    const relay = await aRelay();
    const bad = await call(server, 'POST', '/api/server/smtp', {
      cookie: server.admin.cookie,
      body: smtpBody(relay, 'wrong-password-1'),
    });
    expect(bad.status).toBe(200);
    expect(((await bad.json()) as { ok: boolean; reason?: string }).reason).toBe('auth-failed');
    expect((await readSettings(server.db, cipher)).smtp).toBeUndefined();
    expect(relay.received).toHaveLength(0);
    expect(await trail(server)).toEqual([]);

    const good = await call(server, 'POST', '/api/server/smtp', {
      cookie: server.admin.cookie,
      body: smtpBody(relay),
    });
    expect([good.status, await good.json()]).toEqual([200, { ok: true }]);
    expect(relay.received).toHaveLength(1);
    expect(relay.received[0]?.to).toEqual([server.admin.email]);
    expect(relay.received[0]?.data).not.toContain('/setup/verify');
    expect((await readSettings(server.db, cipher)).smtp?.from).toBe('purlay@example.test');
    expect((await viewOf(server)).channels.email).toBe(true);
    expect((await trail(server)).map((row) => row.action)).toEqual(['server.smtp_connected']);
  });

  test('an address that cannot be tried is refused as input, and nothing is sent', async () => {
    const server = await aServer();
    const response = await call(server, 'POST', '/api/server/smtp', {
      cookie: server.admin.cookie,
      body: {
        smtpUrl: 'http://not-smtp.example.test',
        from: 'a@example.test',
        allowPlaintext: false,
      },
    });
    expect(response.status).toBe(400);
    expect(
      ((await response.json()) as { error: { details: { fields: object } } }).error.details.fields,
    ).toHaveProperty('smtpUrl');
  });

  test('the last way in is not disconnected without saying so, and two disconnects at once cannot both pass', async () => {
    const server = await aServer();
    const relay = await aRelay();
    const as = { cookie: server.admin.cookie };
    // Nothing connected: nothing to disconnect.
    const none = await call(server, 'DELETE', '/api/server/github', as);
    expect([
      none.status,
      ((await none.json()) as { error: { code: string; details: unknown } }).error.details,
    ]).toEqual([409, { reason: 'not-connected' }]);

    await call(server, 'POST', '/api/server/github', { ...as, body: GITHUB_OK });
    const last = await call(server, 'DELETE', '/api/server/github', as);
    expect(last.status).toBe(409);
    expect(await last.json()).toMatchObject({
      error: { code: 'SERVER_CHANGE_REFUSED', details: { reason: 'last-channel' } },
    });
    expect((await readSettings(server.db, cipher)).github).toBeDefined();
    expect(await trail(server).then((rows) => rows.map((row) => row.action))).toEqual([
      'server.github_connected',
    ]);

    // With the relay too, either may go; both at once, never.
    await call(server, 'POST', '/api/server/smtp', { ...as, body: smtpBody(relay) });
    const [first, second] = await Promise.all([
      call(server, 'DELETE', '/api/server/github', as),
      call(server, 'DELETE', '/api/server/smtp', as),
    ]);
    expect([first.status, second.status].sort()).toEqual([204, 409]);
    const left = await readSettings(server.db, cipher);
    expect([left.github, left.smtp].filter((one) => one !== undefined)).toHaveLength(1);

    // Said outright, the last one goes.
    const remaining = left.github === undefined ? 'smtp' : 'github';
    const confirmed = await call(server, 'DELETE', `/api/server/${remaining}`, {
      ...as,
      body: { confirmLastChannel: true },
    });
    expect(confirmed.status).toBe(204);
    const gone = await readSettings(server.db, cipher);
    expect([gone.github, gone.smtp]).toEqual([undefined, undefined]);
    expect((await viewOf(server)).channels).toEqual({ github: false, email: false, oidc: false });
  });

  test('a GitHub secret the key cannot open can be disconnected, under the same last-way-in rule', async () => {
    const server = await aServer({ unreadableGitHub: true });
    const relay = await aRelay();
    const as = { cookie: server.admin.cookie };
    const view = await viewOf(server);
    expect([view.needsReentry, view.settings.github]).toEqual([['github'], null]);
    const sealed = async (): Promise<string | null | undefined> =>
      (
        await server.db
          .selectFrom('server_settings')
          .select('github_client_secret_encrypted')
          .where('id', '=', true)
          .executeTakeFirst()
      )?.github_client_secret_encrypted;

    // Nothing else lets anybody in: refused until said outright, and nothing was cleared.
    const refused = await call(server, 'DELETE', '/api/server/github', as);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { details: { reason: 'last-channel' } } });
    expect(await sealed()).not.toBeNull();

    // With the mail relay serving, it goes — the ciphertext cleared, no longer asked for again.
    await call(server, 'POST', '/api/server/smtp', { ...as, body: smtpBody(relay) });
    const gone = await call(server, 'DELETE', '/api/server/github', as);
    expect(gone.status).toBe(204);
    expect(await sealed()).toBeNull();
    expect((await viewOf(server)).needsReentry).toEqual([]);
    expect((await trail(server)).map((row) => row.action)).toContain('server.github_disconnected');
  });

  test('a disconnect body that is not the contract is refused', async () => {
    const server = await aServer();
    const response = await call(server, 'DELETE', '/api/server/github', {
      cookie: server.admin.cookie,
      body: { confirmLastChannel: 'yes' },
    });
    expect(response.status).toBe(400);
  });

  test('the sign-up policy takes effect on the next request: a newcomer is refused, then let in', async () => {
    const server = await aServer();
    const as = { cookie: server.admin.cookie };
    await call(server, 'POST', '/api/server/github', { ...as, body: GITHUB_OK });
    const refused = await signInWithGitHub(server.app, ORIGIN, server.github);
    expect(refused.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      false,
    );

    expect(
      (await call(server, 'POST', '/api/server/policy', { ...as, body: { signUp: 'open' } }))
        .status,
    ).toBe(204);
    const admitted = await signInWithGitHub(server.app, ORIGIN, server.github);
    expect(admitted.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(
      true,
    );
    expect((await viewOf(server)).settings.signUp).toBe('open');

    const bad = await call(server, 'POST', '/api/server/policy', {
      ...as,
      body: { signUp: 'sometimes' },
    });
    expect(bad.status).toBe(400);
  });

  test('who may create a workspace takes effect on the next request, and a list is held to GitHub logins', async () => {
    const server = await aServer();
    const as = { cookie: server.admin.cookie };
    await server.db
      .updateTable('users')
      .set({ github_id: '910001', github_login: 'Listed-Person' })
      .where('id', '=', server.member.userId)
      .execute();
    const mayCreate = async (user: SignedInUser): Promise<boolean> =>
      ((await (await call(server, 'GET', '/api/me', { cookie: user.cookie })).json()) as MeResponse)
        .mayCreateWorkspace;
    expect(await mayCreate(server.member)).toBe(false);

    const listed = await call(server, 'POST', '/api/server/creators', {
      ...as,
      body: { workspaceCreators: { kind: 'listed', logins: ['Listed-Person'] } },
    });
    expect(listed.status).toBe(204);
    expect(await mayCreate(server.member)).toBe(true);
    expect(await mayCreate(server.owner)).toBe(false);
    expect((await viewOf(server)).settings.workspaceCreators).toEqual({
      kind: 'listed',
      logins: ['listed-person'],
    });

    expect(
      (
        await call(server, 'POST', '/api/server/creators', {
          ...as,
          body: { workspaceCreators: { kind: 'anyone' } },
        })
      ).status,
    ).toBe(204);
    expect(await mayCreate(server.owner)).toBe(true);
    const made = await call(server, 'POST', '/api/workspaces', {
      cookie: server.owner.cookie,
      body: { name: 'Second', slug: aUniqueSlug('second') },
    });
    expect(made.status).toBe(201);

    for (const body of [
      { workspaceCreators: { kind: 'listed', logins: [] } },
      { workspaceCreators: { kind: 'listed', logins: ['not a login!'] } },
      { workspaceCreators: { kind: 'listed', logins: ['-leading-dash'] } },
      { workspaceCreators: { kind: 'someone' } },
      { workspaceCreators: { kind: 'anyone', logins: ['x'] } },
    ]) {
      const refusal = await call(server, 'POST', '/api/server/creators', { ...as, body });
      expect([JSON.stringify(body), refusal.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect((await viewOf(server)).settings.workspaceCreators).toEqual({ kind: 'anyone' });
  });

  test('every change is on the trail — who, from which session, never a value — and no secret is in any line written', async () => {
    const server = await aServer();
    const relay = await aRelay();
    const as = { cookie: server.admin.cookie };
    await call(server, 'POST', '/api/server/github', { ...as, body: GITHUB_OK });
    await call(server, 'POST', '/api/server/smtp', { ...as, body: smtpBody(relay) });
    await call(server, 'POST', '/api/server/policy', { ...as, body: { signUp: 'open' } });
    await call(server, 'POST', '/api/server/creators', {
      ...as,
      body: { workspaceCreators: { kind: 'listed', logins: ['someone-else'] } },
    });
    await call(server, 'DELETE', '/api/server/smtp', as);
    // A failed try, with a secret in it, goes to the log nowhere.
    await call(server, 'POST', '/api/server/github', { ...as, body: GITHUB_BAD });

    const rows = await trail(server);
    expect(rows.map((row) => row.action)).toEqual([
      'server.github_connected',
      'server.smtp_connected',
      'server.sign_up_changed',
      'server.workspace_creators_changed',
      'server.smtp_disconnected',
    ]);
    for (const row of rows) {
      expect(row.actor).toBe(server.admin.userId);
      expect(row.session).toBe(server.admin.sessionId);
    }
    const everything = JSON.stringify(
      await server.db
        .selectFrom('server_audit_log')
        .selectAll()
        .where('actor_user_id', '=', server.admin.userId)
        .execute(),
    );
    for (const secret of [GITHUB_OK.clientSecret, BAD_SECRET, RELAY_PASS, 'someone-else', 'open']) {
      expect(everything).not.toContain(secret);
    }
    const written = server.lines.join('\n');
    for (const secret of [
      GITHUB_OK.clientSecret,
      BAD_SECRET,
      RELAY_PASS,
      RELAY_USER,
      String(smtpBody(relay)['smtpUrl']),
    ]) {
      expect(written).not.toContain(secret);
    }
  });

  test('a change that fails to be saved leaves no row on the trail', async () => {
    const server = await aServer();
    await server.db.schema.dropTable('server_audit_log').execute();
    const response = await call(server, 'POST', '/api/server/policy', {
      cookie: server.admin.cookie,
      body: { signUp: 'open' },
    });
    expect(response.status).toBe(500);
    // The audit row is part of the change: with it failing, nothing was saved and the old settings serve.
    expect((await readSettings(server.db, cipher)).signUp).toBe('invite-only');
    expect(server.holder.current()?.settings.signUp).toBe('invite-only');
  });

  test('while the setup in the browser is open the page refuses, and nothing is changed', async () => {
    const server = await aServer({ noWorkspace: true });
    // The wizard's administrator is the only account: the setup is open.
    await server.db
      .deleteFrom('users')
      .where('id', 'in', [server.member.userId, server.owner.userId])
      .execute();
    await server.db
      .insertInto('setup_state')
      .values({ id: true, admin_user_id: server.admin.userId })
      .onConflict((conflict) =>
        conflict.column('id').doUpdateSet({ admin_user_id: server.admin.userId }),
      )
      .execute();
    for (const [method, path, body] of ROUTES) {
      const response = await call(server, method, path, {
        cookie: server.admin.cookie,
        ...(body === undefined ? {} : { body }),
      });
      expect([method, path, response.status]).toEqual([method, path, 409]);
      expect(await response.json()).toMatchObject({
        error: { code: 'SERVER_CHANGE_REFUSED', details: { reason: 'setup-unfinished' } },
      });
    }
    expect(server.github.presentedCodes).toHaveLength(0);
  });

  test('a cross-site write is refused before anything runs', async () => {
    const server = await aServer();
    const response = await call(server, 'POST', '/api/server/policy', {
      cookie: server.admin.cookie,
      body: { signUp: 'open' },
      origin: 'https://evil.example',
    });
    expect(response.status).toBe(403);
    expect(server.holder.current()?.settings.signUp).toBe('invite-only');
  });

  test('a client is limited: the sixty-first request is 429 with Retry-After, whoever asks, and HEAD is counted', async () => {
    const server = await aServer({ limits: 'real' });
    for (let at = 0; at < 60; at += 1) {
      const response = await call(server, 'GET', '/api/server/settings', {
        cookie: server.admin.cookie,
        client: '198.51.100.9',
      });
      expect(response.status).toBe(200);
    }
    const over = await call(server, 'GET', '/api/server/settings', {
      cookie: server.admin.cookie,
      client: '198.51.100.9',
    });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // Another client is its own.
    expect(
      (
        await call(server, 'GET', '/api/server/settings', {
          cookie: server.admin.cookie,
          client: '198.51.100.10',
        })
      ).status,
    ).toBe(200);
    // A stranger spends the same allowance, and is told the same thing before the guard runs.
    for (let at = 0; at < 60; at += 1) {
      await call(server, 'GET', '/api/server/settings', { client: '198.51.100.11' });
    }
    expect(
      (await call(server, 'GET', '/api/server/settings', { client: '198.51.100.11' })).status,
    ).toBe(429);
    // HEAD is the GET it runs as.
    expect(
      (
        await call(server, 'HEAD', '/api/server/settings', {
          cookie: server.admin.cookie,
          client: '198.51.100.9',
        })
      ).status,
    ).toBe(429);
  });
});

/** A provider served on a loopback port, as the operator would name it, and the body that connects it. */
const aProvider = async (
  behaviour: OidcBehaviour = {},
): Promise<{ readonly stub: OidcStub; readonly body: Record<string, unknown> }> => {
  const stub = await anOidcStub({ sub: 'ada', email: 'ada@example.test' }, behaviour);
  const served = stub.serve(0);
  stops.push(served.stop);
  return { stub, body: { issuer: served.url, ...OIDC_STUB_CREDENTIALS, name: 'Acme SSO' } };
};

describe('integration: Administration → Server — single sign-on (D-200)', () => {
  test('a provider that answers is tried, kept and served, the secret sealed and never shown again', async () => {
    const server = await aServer();
    const { stub, body } = await aProvider();
    const as = { cookie: server.admin.cookie };
    const tried = await call(server, 'POST', '/api/server/oidc', { ...as, body });
    expect(tried.status).toBe(200);
    expect(await tried.json()).toEqual({ ok: true });
    // The client was weighed at the token endpoint with a code nobody was given, before anything was saved.
    expect(stub.refusals).toEqual(['invalid_grant']);

    const view = await viewOf(server);
    expect(view.settings.oidc).toEqual({
      issuer: String(body['issuer']),
      clientId: OIDC_STUB_CREDENTIALS.clientId,
      clientSecret: { set: true },
      name: 'Acme SSO',
    });
    expect(view.channels).toEqual({ github: false, email: false, oidc: true });
    expect(view.oidcCallbackUrl).toBe(`${ORIGIN}${OIDC_CALLBACK}`);
    // Served from the next request: the sign-in screen is told, with the label.
    const methods = await call(server, 'GET', '/api/auth/methods');
    expect(((await methods.json()) as { oidc: unknown }).oidc).toEqual({ name: 'Acme SSO' });

    // Sealed in the settings, bound to its column, and nowhere else.
    const row = await server.db
      .selectFrom('server_settings')
      .select('oidc_client_secret_encrypted')
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(row.oidc_client_secret_encrypted).not.toContain(OIDC_STUB_CREDENTIALS.clientSecret);
    expect((await readSettings(server.db, cipher)).oidc?.clientSecret).toBe(
      OIDC_STUB_CREDENTIALS.clientSecret,
    );
    const everything = [JSON.stringify(view), ...server.lines].join('\n');
    expect(everything).not.toContain(OIDC_STUB_CREDENTIALS.clientSecret);
    // On the trail, without a value.
    expect((await trail(server)).map((entry) => entry.action)).toEqual(['server.oidc_connected']);
  });

  test('a secret the provider refuses saves nothing, says why, and shows none of it', async () => {
    const server = await aServer();
    const { body } = await aProvider();
    const refused = await call(server, 'POST', '/api/server/oidc', {
      cookie: server.admin.cookie,
      body: { ...body, clientSecret: BAD_SECRET },
    });
    expect(refused.status).toBe(200);
    const answer = (await refused.json()) as { ok: boolean; reason: string; raw: string };
    expect([answer.ok, answer.reason]).toEqual([false, 'secret-rejected']);
    expect(JSON.stringify(answer)).not.toContain(BAD_SECRET);
    expect((await readSettings(server.db, cipher)).oidc).toBeUndefined();
    expect(await trail(server)).toEqual([]);
    expect((await viewOf(server)).channels.oidc).toBe(false);
    expect(server.lines.join('\n')).not.toContain(BAD_SECRET);
  });

  test.each<[string, OidcBehaviour, string]>([
    ['names another issuer', { discovery: 'issuer-mismatch' }, 'issuer-mismatch'],
    ['is not a provider this server can use', { discovery: 'no-pkce' }, 'discovery-invalid'],
    ['signs with nothing this server accepts', { discovery: 'hmac-only' }, 'discovery-invalid'],
    ['answers 503 at its discovery address', { discovery: 'refuses' }, 'discovery-invalid'],
    ['publishes no usable keys', { jwks: 'garbage' }, 'unexpected-reply'],
    ['has a token endpoint that is down', { token: 'refuses' }, 'unexpected-reply'],
  ])(
    'a provider that %s is refused with its reason, and nothing is kept',
    async (_what, behaviour, reason) => {
      const server = await aServer();
      const { body } = await aProvider(behaviour);
      const response = await call(server, 'POST', '/api/server/oidc', {
        cookie: server.admin.cookie,
        body,
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { reason: string }).reason).toBe(reason);
      expect((await readSettings(server.db, cipher)).oidc).toBeUndefined();
      expect(await trail(server)).toEqual([]);
    },
  );

  test('a provider nothing answers for is unreachable, said at once and bounded', async () => {
    const server = await aServer();
    const response = await call(server, 'POST', '/api/server/oidc', {
      cookie: server.admin.cookie,
      body: { issuer: 'http://127.0.0.1:1', ...OIDC_STUB_CREDENTIALS },
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { reason: string }).reason).toBe('unreachable');
    expect((await readSettings(server.db, cipher)).oidc).toBeUndefined();
  });

  test('an issuer or a label the settings could not hold is refused as input before the provider is asked', async () => {
    const server = await aServer();
    const { stub, body } = await aProvider();
    const as = { cookie: server.admin.cookie };
    for (const [bad, field] of [
      [{ issuer: 'http://idp.example.test' }, 'issuer'],
      [{ issuer: 'https://user:pw@idp.example.test' }, 'issuer'],
      [{ issuer: 'https://idp.example.test/?tenant=1' }, 'issuer'],
      [{ issuer: 'not an address' }, 'issuer'],
      [{ name: 'Acme‮SSO' }, 'name'],
      [{ name: ' Acme' }, 'name'],
      [{ name: 'x'.repeat(41) }, 'name'],
    ] as const) {
      const response = await call(server, 'POST', '/api/server/oidc', {
        ...as,
        body: { ...body, ...bad },
      });
      expect([JSON.stringify(bad), response.status]).toEqual([JSON.stringify(bad), 400]);
      expect(JSON.stringify(await response.json())).toContain(field);
    }
    // A body that is not the contract.
    for (const bad of [
      { ...body, clientSecret: '' },
      { ...body, issuer: 1 },
      { issuer: body['issuer'] },
    ]) {
      expect((await call(server, 'POST', '/api/server/oidc', { ...as, body: bad })).status).toBe(
        400,
      );
    }
    expect(stub.calls.urls).toEqual([]);
    expect((await readSettings(server.db, cipher)).oidc).toBeUndefined();
  });

  test('replacing it tries the new one, and no label is the default the client words', async () => {
    const server = await aServer();
    const { body } = await aProvider();
    const as = { cookie: server.admin.cookie };
    await call(server, 'POST', '/api/server/oidc', { ...as, body });
    const withoutName = { ...body };
    Reflect.deleteProperty(withoutName, 'name');
    expect(
      (await call(server, 'POST', '/api/server/oidc', { ...as, body: withoutName })).status,
    ).toBe(200);
    expect((await viewOf(server)).settings.oidc?.name).toBeNull();
    const methods = await call(server, 'GET', '/api/auth/methods');
    expect(((await methods.json()) as { oidc: unknown }).oidc).toEqual({ name: null });
  });

  test('disconnecting the only way in asks first; said outright it goes, and nothing is left behind', async () => {
    const server = await aServer();
    const { body } = await aProvider();
    const as = { cookie: server.admin.cookie };
    await call(server, 'POST', '/api/server/oidc', { ...as, body });
    const refused = await call(server, 'DELETE', '/api/server/oidc', as);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { details: { reason: 'last-channel' } } });
    expect((await readSettings(server.db, cipher)).oidc).toBeDefined();

    const gone = await call(server, 'DELETE', '/api/server/oidc', {
      ...as,
      body: { confirmLastChannel: true },
    });
    expect(gone.status).toBe(204);
    expect((await readSettings(server.db, cipher)).oidc).toBeUndefined();
    const row = await server.db
      .selectFrom('server_settings')
      .select(['oidc_issuer', 'oidc_client_id', 'oidc_client_secret_encrypted', 'oidc_name'])
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(Object.values(row)).toEqual([null, null, null, null]);
    expect((await viewOf(server)).channels.oidc).toBe(false);
    // The route does not exist once it is off.
    expect((await call(server, 'GET', '/auth/oidc')).status).toBe(404);
    expect((await trail(server)).map((entry) => entry.action)).toEqual([
      'server.oidc_connected',
      'server.oidc_disconnected',
    ]);
    // Disconnecting what is not connected is said, and writes nothing.
    const again = await call(server, 'DELETE', '/api/server/oidc', as);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { details: { reason: 'not-connected' } } });
  });

  test('with another way in serving, disconnecting needs no confirmation: single sign-on counts as one of three', async () => {
    const server = await aServer();
    const relay = await aRelay();
    const { body } = await aProvider();
    const as = { cookie: server.admin.cookie };
    await call(server, 'POST', '/api/server/smtp', { ...as, body: smtpBody(relay) });
    await call(server, 'POST', '/api/server/oidc', { ...as, body });
    expect((await call(server, 'DELETE', '/api/server/oidc', as)).status).toBe(204);
    // And the other way round: the relay is now the last, and is asked about.
    expect((await call(server, 'DELETE', '/api/server/smtp', as)).status).toBe(409);
  });

  test('two disconnects at once cannot both remove the last of two ways in', async () => {
    const server = await aServer();
    const relay = await aRelay();
    const { body } = await aProvider();
    const as = { cookie: server.admin.cookie };
    await call(server, 'POST', '/api/server/smtp', { ...as, body: smtpBody(relay) });
    await call(server, 'POST', '/api/server/oidc', { ...as, body });
    const [first, second] = await Promise.all([
      call(server, 'DELETE', '/api/server/oidc', as),
      call(server, 'DELETE', '/api/server/smtp', as),
    ]);
    expect([first.status, second.status].sort()).toEqual([204, 409]);
    const settings = await readSettings(server.db, cipher);
    expect([settings.oidc, settings.smtp].filter((value) => value !== undefined)).toHaveLength(1);
  });

  test('a secret the key cannot open is read as unset and needs entering again', async () => {
    const server = await aServer();
    const { body } = await aProvider();
    await saveSettings(
      server.db,
      credentialCipher('a-different-key-of-the-right-shape-0123456789abcdef'),
      systemClock,
      { oidc: { issuer: String(body['issuer']), ...OIDC_STUB_CREDENTIALS, name: undefined } },
    );
    const boot = await readSettingsToBoot(server.db, cipher);
    expect([boot.needsReentry, boot.settings.oidc]).toEqual([['oidc'], undefined]);
  });

  test('a client is limited as every route under /api/server: the sixty-first try is 429', async () => {
    const server = await aServer({ limits: 'real' });
    const body = { issuer: 'http://127.0.0.1:1', ...OIDC_STUB_CREDENTIALS };
    for (let at = 0; at < 60; at += 1) {
      const response = await call(server, 'POST', '/api/server/oidc', {
        cookie: server.admin.cookie,
        client: '198.51.100.40',
        body,
      });
      expect(response.status).toBe(200);
    }
    const over = await call(server, 'POST', '/api/server/oidc', {
      cookie: server.admin.cookie,
      client: '198.51.100.40',
      body,
    });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });
});

describe('integration: Administration → Server — the sign-in policy (D-239)', () => {
  const as = (server: Server): Call => ({ cookie: server.admin.cookie });
  const refusalOf = async (response: Response): Promise<[number, unknown]> => [
    response.status,
    ((await response.json()) as { error: { details?: { reason?: unknown } } }).error.details
      ?.reason,
  ];
  const methods = async (server: Server): Promise<{ password: boolean }> =>
    (await (await call(server, 'GET', '/api/auth/methods')).json()) as { password: boolean };

  test('each rule changes on its own, serves from the next request, and is on the trail without its value', async () => {
    const server = await aServer();
    await call(server, 'POST', '/api/server/github', { ...as(server), body: GITHUB_OK });
    const required = await call(server, 'POST', '/api/server/policy', {
      ...as(server),
      body: { requireTwoFactor: true },
    });
    expect(required.status).toBe(204);
    expect(server.holder.current()?.auth.signInPolicy).toEqual({
      requireTwoFactor: true,
      passwordSignIn: true,
    });
    const off = await call(server, 'POST', '/api/server/policy', {
      ...as(server),
      body: { passwordSignIn: false },
    });
    expect(off.status).toBe(204);
    // The other rule is left as it was: each change names one.
    expect((await viewOf(server)).settings).toMatchObject({
      signUp: 'invite-only',
      requireTwoFactor: true,
      passwordSignIn: false,
    });
    expect((await methods(server)).password).toBe(false);
    expect(
      (
        await call(server, 'POST', '/api/server/policy', {
          ...as(server),
          body: { passwordSignIn: true },
        })
      ).status,
    ).toBe(204);
    expect((await methods(server)).password).toBe(true);
    expect((await trail(server)).map((row) => row.action)).toEqual([
      'server.github_connected',
      'server.two_factor_requirement_changed',
      'server.password_sign_in_changed',
      'server.password_sign_in_changed',
    ]);
    for (const row of await trail(server)) expect(row.session).toBe(server.admin.sessionId);
  });

  test('passwords are turned off only while GitHub or single sign-on serves — the mail relay is not one of them', async () => {
    const server = await aServer();
    const relay = await aRelay();
    await call(server, 'POST', '/api/server/smtp', { ...as(server), body: smtpBody(relay) });
    const refused = await call(server, 'POST', '/api/server/policy', {
      ...as(server),
      body: { passwordSignIn: false },
    });
    expect(await refusalOf(refused)).toEqual([409, 'no-provider']);
    expect((await readSettings(server.db, cipher)).passwordSignIn).toBe(true);
    expect((await methods(server)).password).toBe(true);
    expect((await trail(server)).map((row) => row.action)).toEqual(['server.smtp_connected']);

    const { body } = await aProvider();
    await call(server, 'POST', '/api/server/oidc', { ...as(server), body });
    expect(
      (
        await call(server, 'POST', '/api/server/policy', {
          ...as(server),
          body: { passwordSignIn: false },
        })
      ).status,
    ).toBe(204);
  });

  test('with passwords off the last of GitHub and single sign-on stays, confirmed or not; the relay and the other provider may go', async () => {
    const server = await aServer();
    const relay = await aRelay();
    const { body } = await aProvider();
    await call(server, 'POST', '/api/server/github', { ...as(server), body: GITHUB_OK });
    await call(server, 'POST', '/api/server/oidc', { ...as(server), body });
    await call(server, 'POST', '/api/server/smtp', { ...as(server), body: smtpBody(relay) });
    await call(server, 'POST', '/api/server/policy', {
      ...as(server),
      body: { passwordSignIn: false },
    });

    expect((await call(server, 'DELETE', '/api/server/smtp', as(server))).status).toBe(204);
    expect((await call(server, 'DELETE', '/api/server/oidc', as(server))).status).toBe(204);
    for (const confirmLastChannel of [false, true]) {
      const last = await call(server, 'DELETE', '/api/server/github', {
        ...as(server),
        body: { confirmLastChannel },
      });
      expect(await refusalOf(last)).toEqual([409, 'passwords-off']);
    }
    expect((await readSettings(server.db, cipher)).github).toBeDefined();
    expect((await viewOf(server)).channels.github).toBe(true);
  });

  test('two administrators at once — one turning passwords off, one disconnecting the only provider — cannot both pass', async () => {
    for (let round = 0; round < 3; round += 1) {
      // No workspace to make: its trail would read the session of the round before's request.
      const server = await aServer({ noWorkspace: true });
      const relay = await aRelay();
      await server.db
        .updateTable('users')
        .set({ is_server_admin: true })
        .where('id', '=', server.member.userId)
        .execute();
      await call(server, 'POST', '/api/server/github', { ...as(server), body: GITHUB_OK });
      await call(server, 'POST', '/api/server/smtp', { ...as(server), body: smtpBody(relay) });
      const [off, gone] = await Promise.all([
        call(server, 'POST', '/api/server/policy', {
          ...as(server),
          body: { passwordSignIn: false },
        }),
        call(server, 'DELETE', '/api/server/github', {
          cookie: server.member.cookie,
          body: { confirmLastChannel: true },
        }),
      ]);
      expect([off.status, gone.status].sort()).toEqual([204, 409]);
      const settings = await readSettings(server.db, cipher);
      // Whichever won, somebody can still sign in: a password, or GitHub.
      expect(settings.passwordSignIn || settings.github !== undefined).toBe(true);
      expect(settings.passwordSignIn).toBe(off.status !== 204);
    }
  });

  test('two administrators changing two rules at once both keep, each on the trail', async () => {
    const server = await aServer();
    await server.db
      .updateTable('users')
      .set({ is_server_admin: true })
      .where('id', '=', server.member.userId)
      .execute();
    await call(server, 'POST', '/api/server/github', { ...as(server), body: GITHUB_OK });
    const answers = await Promise.all([
      call(server, 'POST', '/api/server/policy', {
        ...as(server),
        body: { requireTwoFactor: true },
      }),
      call(server, 'POST', '/api/server/policy', {
        cookie: server.member.cookie,
        body: { passwordSignIn: false },
      }),
      call(server, 'POST', '/api/server/policy', { ...as(server), body: { signUp: 'open' } }),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([204, 204, 204]);
    expect(await readSettings(server.db, cipher)).toMatchObject({
      requireTwoFactor: true,
      passwordSignIn: false,
      signUp: 'open',
    });
    const actions = await server.db
      .selectFrom('server_audit_log')
      .select('action')
      .where('action', 'in', [
        'server.two_factor_requirement_changed',
        'server.password_sign_in_changed',
        'server.sign_up_changed',
      ])
      .execute();
    expect(actions.map((row) => row.action).sort()).toEqual([
      'server.password_sign_in_changed',
      'server.sign_up_changed',
      'server.two_factor_requirement_changed',
    ]);
  });

  test('a body that is not one rule, of the right type, is refused before anything changes', async () => {
    const server = await aServer();
    for (const body of [
      {},
      { requireTwoFactor: 'yes' },
      { passwordSignIn: 1 },
      { requireTwoFactor: true, passwordSignIn: true },
      { requireTwoFactor: true, extra: true },
    ]) {
      const refused = await call(server, 'POST', '/api/server/policy', { ...as(server), body });
      expect([JSON.stringify(body), refused.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect(await trail(server)).toEqual([]);
  });
});

describe('integration: server runtime compatibility paths', () => {
  test('integration: disconnect rejects malformed JSON before changing server settings', async () => {
    const server = await aServer();
    const before = await viewOf(server);
    const response = await server.app.handle(
      new Request(`${ORIGIN}/api/server/github`, {
        method: 'DELETE',
        headers: {
          origin: ORIGIN,
          cookie: server.admin.cookie,
          'content-type': 'application/json',
        },
        body: '{broken',
      }),
    );
    expect(response.status).toBe(400);
    expect(await viewOf(server)).toEqual(before);
  });

  test('integration: a Turkish administrator receives a Turkish relay test letter', async () => {
    const server = await aServer();
    const relay = await aRelay();
    await server.db
      .updateTable('users')
      .set({ locale: 'tr' })
      .where('id', '=', server.admin.userId)
      .execute();
    const response = await call(server, 'POST', '/api/server/smtp', {
      cookie: server.admin.cookie,
      body: smtpBody(relay),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(relay.received[0]?.data).toContain('Purlay sunucundan bir deneme');
    expect(relay.received[0]?.data).not.toContain('A test from your Purlay server');
  });
});
