import { signInWithOidc } from '../../testing/oidc-sign-in';
import * as administrationInventory from '../../modules/administration/inventory';
import * as admissionChanges from '../../modules/administration/admission';
import * as setupAuthority from '../../modules/setup/setup';
import { signInWithGoogle } from '../../testing/google-sign-in';
import { startGitHubSignIn, returnFromGitHub } from '../../testing/github-sign-in';
import type {
  ServerAuditPage,
  ServerMailTest,
  ServerOperations,
  ServerOverview,
  ServerUserDetail,
  ServerUserPage,
  ServerWorkspacePage,
} from '@purlay/types';
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
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type Executor,
  DROP_HOOK_MS,
} from '@purlay/db';
import {
  messageId,
  SERVER_AUDIT_EXPORT_COLUMNS,
  GITHUB_APP_CALLBACK,
  GITHUB_APP_WEBHOOK,
  GOOGLE_CALLBACK,
  OIDC_CALLBACK,
  SIGN_IN_CALLBACK,
  type MeResponse,
  type ServerSettingsAnswer,
} from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { systemClock, fixedClock, type Clock } from '../../platform/clock';
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
import { chatWorkspaceHooks } from '../../features/chat/channels/workspace-hooks';
import { atomicallyOn } from '../../platform/transactions';
import { inProcessEventBus } from '../../realtime/bus';
import type { RateBudget } from '../../realtime/rate-limiter';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aGitHubPerson, cookiesFrom, signInWithGitHub } from '../../testing/github-sign-in';
import { aGitHubStub, GITHUB_STUB_CREDENTIALS, type GitHubStub } from '../../testing/github-stub';
import { aGitHubAppStub, GITHUB_APP_STUB } from '../../testing/github-app-stub';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import {
  anOidcStub,
  OIDC_STUB_CREDENTIALS,
  type OidcBehaviour,
  type OidcStub,
} from '../../testing/oidc-stub';
import { describeNeeding } from '../../testing/needs';
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
// Release each test's servers and clone before the next case: retaining every pool until the
// file ends exhausts PostgreSQL's connection cap when this suite grows (#1169, D-228).
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
  await Promise.all(
    clones.splice(0).map(async (drop) => {
      await drop();
    }),
  );
}, DROP_HOOK_MS);
afterAll(async () => {
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
  /** Google, as the double plays it, served on a loopback port; the server's probe is pointed at it. */
  readonly google: OidcStub;
  readonly person: ReturnType<typeof aGitHubPerson>;
  readonly admin: SignedInUser;
  readonly member: SignedInUser;
  /** An owner of a workspace: not the server's administrator. */
  readonly owner: SignedInUser;
}

const aServer = async (
  options: {
    readonly limits?: 'real';
    readonly clock?: Clock;
    readonly noWorkspace?: boolean;
    /** A GitHub app sealed under another key before the start: read as unset, needing entry again. */
    readonly unreadableGitHub?: boolean;
    /** How many nodes of the cluster do not read workspace grants (D-292); left out, there is one node. */
    readonly peersBehind?: () => Promise<number>;
  } = {},
): Promise<Server> => {
  const clock = options.clock ?? systemClock;
  const cloned = await cloneIntegrationDatabase();
  clones.push(cloned.drop);
  const person = aGitHubPerson();
  // The GitHub the server talks to also plays the App issues are written through (D-246).
  const github = aGitHubStub(person, {}, GITHUB_STUB_CREDENTIALS, {
    app: aGitHubAppStub({ id: person.id, login: person.login }),
  });
  const served = github.serve(0);
  stops.push(served.stop);
  const google = await anOidcStub({ sub: 'grace', email: 'grace@gmail.com' });
  stops.push(google.serve(0).stop);
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
        googleIssuer: google.issuer(),
        sessionTtlDays: 30,
        bus: inProcessEventBus(() => undefined, NO_LOG),
        clock: clock,
      },
      needsReentry,
      holder.sends,
    );
  const admin = await aSignedInUser(cloned.db, clock, 'srv-admin');
  await cloned.db
    .updateTable('users')
    .set({ is_server_admin: true })
    .where('id', '=', admin.userId)
    .execute();
  const member = await aSignedInUser(cloned.db, clock, 'srv-member');
  const owner = await aSignedInUser(cloned.db, clock, 'srv-owner');
  if (options.noWorkspace !== true) {
    await atomicallyOn(cloned.db)(
      async (transaction) =>
        await createWorkspace(
          transaction,
          clock,
          owner.userId,
          { name: 'Owned', slug: aUniqueSlug('owned') },
          chatWorkspaceHooks(),
        ),
    );
  }
  if (options.unreadableGitHub === true) {
    await saveSettings(
      cloned.db,
      credentialCipher('a-different-key-of-the-right-shape-0123456789abcdef'),
      clock,
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
      clock: clock,
      log,
      ...(options.peersBehind === undefined ? {} : { peersBehind: options.peersBehind }),
      googleIssuer: google.issuer(),
      auth: holder.auth,
      services: holder,
      workspaceCreators: readWorkspaceCreators,
      settingsChange: { holder, cipher, clock: clock, log, build },
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
  return { app, db: cloned.db, holder, lines, github, google, person, admin, member, owner };
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
  ['POST', '/api/server/google', { ...OIDC_STUB_CREDENTIALS }],
  ['DELETE', '/api/server/google', undefined],
  ['POST', '/api/server/github-app', { ...GITHUB_APP_STUB }],
  ['DELETE', '/api/server/github-app', undefined],
  ['POST', '/api/server/policy', { signUp: 'open' }],
  ['POST', '/api/server/policy', { requireTwoFactor: true }],
  ['POST', '/api/server/policy', { passwordSignIn: false }],
  ['POST', '/api/server/policy', { sessionIdleTimeoutHours: 1 }],
  ['POST', '/api/server/policy', { sessionMaxAgeDays: 1 }],
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
        google: null,
        smtp: null,
        githubApp: null,
        workspaceCreators: { kind: 'first' },
        setupCompletedAt: null,
        requireTwoFactor: false,
        passwordSignIn: true,
        sessionIdleTimeoutHours: null,
        sessionMaxAgeDays: null,
      },
      needsReentry: [],
      appUrl: ORIGIN,
      githubCallbackUrl: `${ORIGIN}${SIGN_IN_CALLBACK}`,
      oidcCallbackUrl: `${ORIGIN}${OIDC_CALLBACK}`,
      googleCallbackUrl: `${ORIGIN}${GOOGLE_CALLBACK}`,
      githubApp: {
        callbackUrl: `${ORIGIN}${GITHUB_APP_CALLBACK}`,
        webhookUrl: `${ORIGIN}${GITHUB_APP_WEBHOOK}`,
      },
      channels: { github: false, email: false, oidc: false, google: false },
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
    expect(connected.channels).toEqual({ github: true, email: true, oidc: false, google: false });
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
    expect((await viewOf(server)).channels).toEqual({
      github: false,
      email: false,
      oidc: false,
      google: false,
    });
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
    expect(view.channels).toEqual({ github: false, email: false, oidc: true, google: false });
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

  test('passwords are turned off only while GitHub, Google or single sign-on serves — the mail relay is not one of them', async () => {
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

  test('with passwords off the last of GitHub, Google and single sign-on stays, confirmed or not; the relay and the other provider may go', async () => {
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

describe('integration: Administration → Server — how long a session lives (D-244)', () => {
  const as = (server: Server): Call => ({ cookie: server.admin.cookie });
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const travel = async (
    server: Server,
    sessionId: string,
    times: { readonly createdAt?: Date; readonly lastUsedAt?: Date },
  ): Promise<void> => {
    await server.db
      .updateTable('sessions')
      .set({
        ...(times.createdAt === undefined ? {} : { created_at: times.createdAt }),
        ...(times.lastUsedAt === undefined ? {} : { last_used_at: times.lastUsedAt }),
      })
      .where('id', '=', sessionId)
      .execute();
  };
  const ago = (ms: number): Date => new Date(Date.now() - ms);
  const sessionLeft = async (server: Server, sessionId: string): Promise<boolean> =>
    (await server.db
      .selectFrom('sessions')
      .select('id')
      .where('id', '=', sessionId)
      .executeTakeFirst()) !== undefined;

  test('each rule applies from the next request to the sessions already open, and is on the trail without its value', async () => {
    const server = await aServer();
    // The control: unused for two hours and signed in eight days ago, both still sign in today.
    await travel(server, server.member.sessionId, { lastUsedAt: ago(2 * HOUR) });
    await travel(server, server.owner.sessionId, { createdAt: ago(8 * DAY) });
    expect((await call(server, 'GET', '/api/me', { cookie: server.member.cookie })).status).toBe(
      200,
    );
    expect((await call(server, 'GET', '/api/me', { cookie: server.owner.cookie })).status).toBe(
      200,
    );
    // Those reads were use; the member is left unused for two hours again.
    await travel(server, server.member.sessionId, { lastUsedAt: ago(2 * HOUR) });

    const idle = await call(server, 'POST', '/api/server/policy', {
      ...as(server),
      body: { sessionIdleTimeoutHours: 1 },
    });
    expect(idle.status).toBe(204);
    expect(server.holder.current()?.auth.sessionLifetime).toEqual({
      sessionIdleTimeoutHours: 1,
      sessionMaxAgeDays: null,
    });
    expect((await call(server, 'GET', '/api/me', { cookie: server.member.cookie })).status).toBe(
      401,
    );
    expect(await sessionLeft(server, server.member.sessionId)).toBe(false);
    // The owner was used a moment ago: the idle timeout leaves it; the administrator's own session too.
    expect((await call(server, 'GET', '/api/me', { cookie: server.owner.cookie })).status).toBe(
      200,
    );

    const aged = await call(server, 'POST', '/api/server/policy', {
      ...as(server),
      body: { sessionMaxAgeDays: 7 },
    });
    expect(aged.status).toBe(204);
    expect((await viewOf(server)).settings).toMatchObject({
      sessionIdleTimeoutHours: 1,
      sessionMaxAgeDays: 7,
      // Each change names one rule: the others are as they were.
      signUp: 'invite-only',
      requireTwoFactor: false,
      passwordSignIn: true,
    });
    expect((await call(server, 'GET', '/api/me', { cookie: server.owner.cookie })).status).toBe(
      401,
    );
    expect(await sessionLeft(server, server.owner.sessionId)).toBe(false);

    // Off again: a session neither rule would have kept signs in as before.
    for (const body of [{ sessionIdleTimeoutHours: null }, { sessionMaxAgeDays: null }]) {
      expect(
        (await call(server, 'POST', '/api/server/policy', { ...as(server), body })).status,
      ).toBe(204);
    }
    const kept = await aSignedInUser(server.db, systemClock, 'srv-kept');
    await travel(server, kept.sessionId, { createdAt: ago(20 * DAY), lastUsedAt: ago(9 * DAY) });
    expect((await call(server, 'GET', '/api/me', { cookie: kept.cookie })).status).toBe(200);
    expect(await readSettings(server.db, cipher)).toMatchObject({
      sessionIdleTimeoutHours: null,
      sessionMaxAgeDays: null,
    });

    const session = server.admin.sessionId;
    expect(await trail(server)).toEqual([
      { action: 'server.session_idle_timeout_changed', actor: server.admin.userId, session },
      { action: 'server.session_max_age_changed', actor: server.admin.userId, session },
      { action: 'server.session_idle_timeout_changed', actor: server.admin.userId, session },
      { action: 'server.session_max_age_changed', actor: server.admin.userId, session },
    ]);
  });

  test('only a value the page offers is taken: anything else is refused before anything changes', async () => {
    const server = await aServer();
    for (const body of [
      { sessionIdleTimeoutHours: 2 },
      { sessionIdleTimeoutHours: 0 },
      { sessionIdleTimeoutHours: -1 },
      { sessionIdleTimeoutHours: '8' },
      { sessionIdleTimeoutHours: 8.5 },
      { sessionMaxAgeDays: 365 },
      { sessionMaxAgeDays: 0 },
      { sessionMaxAgeDays: 'yedi gün' },
      { sessionIdleTimeoutHours: 1, sessionMaxAgeDays: 7 },
      { sessionMaxAgeDays: 7, signUp: 'open' },
    ]) {
      const refused = await call(server, 'POST', '/api/server/policy', { ...as(server), body });
      expect([JSON.stringify(body), refused.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect(await trail(server)).toEqual([]);
    expect(await readSettings(server.db, cipher)).toMatchObject({
      sessionIdleTimeoutHours: null,
      sessionMaxAgeDays: null,
    });
  });
});

describe('integration: Administration → Server — the GitHub App (D-246)', () => {
  const ANOTHER_KEY = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;

  const tryApp = async (
    server: Server,
    over: Readonly<Record<string, unknown>> = {},
  ): Promise<Response> =>
    await call(server, 'POST', '/api/server/github-app', {
      cookie: server.admin.cookie,
      body: { ...GITHUB_APP_STUB, ...over },
    });

  test('tried as its client and as itself, kept only when both hold, and never shown again', async () => {
    const server = await aServer();
    for (const [over, reason] of [
      [{ clientSecret: BAD_SECRET }, 'secret-rejected'],
      [{ privateKey: ANOTHER_KEY }, 'key-rejected'],
      [{ appId: 4243 }, 'app-mismatch'],
      [{ slug: 'another-app' }, 'app-mismatch'],
    ] as const) {
      const answer = (await (await tryApp(server, over)).json()) as { ok: boolean; reason: string };
      expect([answer.ok, answer.reason]).toEqual([false, reason]);
    }
    expect((await viewOf(server)).settings.githubApp).toBeNull();
    expect(await trail(server)).toEqual([]);

    const kept = await tryApp(server);
    expect(await kept.json()).toEqual({ ok: true });
    const view = await viewOf(server);
    expect(view.settings.githubApp).toEqual({
      appId: GITHUB_APP_STUB.appId,
      slug: GITHUB_APP_STUB.slug,
      clientId: GITHUB_APP_STUB.clientId,
      clientSecret: { set: true },
      privateKey: { set: true },
      webhookSecret: { set: true },
    });
    expect(view.githubApp).toEqual({
      callbackUrl: `${ORIGIN}/api/github-app/callback`,
      webhookUrl: `${ORIGIN}/api/webhooks/github-app`,
    });
    // It serves at once: what the holder serves now is the App.
    expect(server.holder.current()?.settings.githubApp?.appId).toBe(GITHUB_APP_STUB.appId);
    const written = [JSON.stringify(view), ...server.lines].join('\n');
    for (const secret of [
      GITHUB_APP_STUB.clientSecret,
      GITHUB_APP_STUB.webhookSecret,
      'BEGIN RSA PRIVATE KEY',
    ]) {
      expect(written).not.toContain(secret);
    }

    expect(
      (await call(server, 'DELETE', '/api/server/github-app', { cookie: server.admin.cookie }))
        .status,
    ).toBe(204);
    expect((await viewOf(server)).settings.githubApp).toBeNull();
    const again = await call(server, 'DELETE', '/api/server/github-app', {
      cookie: server.admin.cookie,
    });
    expect(again.status).toBe(409);
    expect((await trail(server)).map((entry) => entry.action)).toEqual([
      'server.github_app_connected',
      'server.github_app_disconnected',
    ]);
  });

  test('a key this server could not sign with is refused as input, and GitHub is not asked', async () => {
    const server = await aServer();
    const asked = server.github.calls.urls.length;
    const refused = await tryApp(server, { privateKey: '-----BEGIN NOTHING-----' });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        details: { fields: { privateKey: 'is not a PEM private key' } },
      },
    });
    expect(server.github.calls.urls.length).toBe(asked);
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

describe('integration: Administration → Server — Google (D-251)', () => {
  const as = (server: Server): { cookie: string } => ({ cookie: server.admin.cookie });
  const google = { ...OIDC_STUB_CREDENTIALS };
  const refusalOf = async (response: Response): Promise<[number, unknown]> => [
    response.status,
    ((await response.json()) as { error: { details: { reason: unknown } } }).error.details.reason,
  ];

  test('a client Google takes is tried, kept and served, the secret sealed and never shown again', async () => {
    const server = await aServer();
    const tried = await call(server, 'POST', '/api/server/google', { ...as(server), body: google });
    expect(tried.status).toBe(200);
    expect(await tried.json()).toEqual({ ok: true });
    // Weighed at the token endpoint with a code nobody was given, before anything was saved.
    expect(server.google.refusals).toEqual(['invalid_grant']);
    const view = await viewOf(server);
    expect(view.settings.google).toEqual({
      clientId: OIDC_STUB_CREDENTIALS.clientId,
      clientSecret: { set: true },
    });
    expect(view.channels.google).toBe(true);
    expect(view.googleCallbackUrl).toBe(`${ORIGIN}${GOOGLE_CALLBACK}`);
    const row = await server.db
      .selectFrom('server_settings')
      .select('google_client_secret_encrypted')
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(row.google_client_secret_encrypted).not.toContain(OIDC_STUB_CREDENTIALS.clientSecret);
    expect((await readSettings(server.db, cipher)).google?.clientSecret).toBe(
      OIDC_STUB_CREDENTIALS.clientSecret,
    );
    expect([JSON.stringify(view), ...server.lines].join('\n')).not.toContain(
      OIDC_STUB_CREDENTIALS.clientSecret,
    );
    expect((await trail(server)).map((entry) => entry.action)).toEqual(['server.google_connected']);
  });

  test('a secret Google refuses saves nothing, says why, writes no trail and shows none of it', async () => {
    const server = await aServer();
    const refused = await call(server, 'POST', '/api/server/google', {
      ...as(server),
      body: { ...google, clientSecret: BAD_SECRET },
    });
    expect(refused.status).toBe(200);
    const answer = (await refused.json()) as { ok: boolean; reason: string };
    expect([answer.ok, answer.reason]).toEqual([false, 'secret-rejected']);
    expect(JSON.stringify(answer)).not.toContain(BAD_SECRET);
    expect((await readSettings(server.db, cipher)).google).toBeUndefined();
    expect(await trail(server)).toEqual([]);
    expect((await viewOf(server)).channels.google).toBe(false);
    expect(server.lines.join('\n')).not.toContain(BAD_SECRET);
  });

  test('a body that is not a client id and a secret is refused as input', async () => {
    const server = await aServer();
    const bad = await call(server, 'POST', '/api/server/google', {
      ...as(server),
      body: { clientId: '', clientSecret: 'x' },
    });
    expect(bad.status).toBe(400);
    expect((await readSettings(server.db, cipher)).google).toBeUndefined();
  });

  test('the members and the signed out are met as everyone is: absent', async () => {
    const server = await aServer();
    for (const cookie of [server.member.cookie, server.owner.cookie, undefined]) {
      const response = await call(server, 'POST', '/api/server/google', { cookie, body: google });
      expect(response.status).toBe(404);
    }
    expect(server.google.refusals).toEqual([]);
  });

  test('Google as the only way in is asked about; said outright it goes, with its trail', async () => {
    const server = await aServer();
    await call(server, 'POST', '/api/server/google', { ...as(server), body: google });
    const refused = await call(server, 'DELETE', '/api/server/google', as(server));
    expect(await refusalOf(refused)).toEqual([409, 'last-channel']);
    expect((await readSettings(server.db, cipher)).google).toBeDefined();
    const gone = await call(server, 'DELETE', '/api/server/google', {
      ...as(server),
      body: { confirmLastChannel: true },
    });
    expect(gone.status).toBe(204);
    const row = await server.db
      .selectFrom('server_settings')
      .select(['google_client_id', 'google_client_secret_encrypted'])
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(Object.values(row)).toEqual([null, null]);
    expect((await viewOf(server)).channels.google).toBe(false);
    expect((await trail(server)).map((entry) => entry.action)).toEqual([
      'server.google_connected',
      'server.google_disconnected',
    ]);
    const again = await call(server, 'DELETE', '/api/server/google', as(server));
    expect(await refusalOf(again)).toEqual([409, 'not-connected']);
  });

  test('Google counts as a way in: with another serving no confirmation is needed, and it keeps the others from being the last', async () => {
    const server = await aServer();
    const relay = await aRelay();
    await call(server, 'POST', '/api/server/smtp', { ...as(server), body: smtpBody(relay) });
    await call(server, 'POST', '/api/server/google', { ...as(server), body: google });
    expect((await call(server, 'DELETE', '/api/server/smtp', as(server))).status).toBe(204);
    // Now Google is the last.
    expect((await call(server, 'DELETE', '/api/server/google', as(server))).status).toBe(409);
  });

  test('with Google the only provider, passwords may be turned off, and Google then stays', async () => {
    const server = await aServer();
    await call(server, 'POST', '/api/server/google', { ...as(server), body: google });
    expect(
      (
        await call(server, 'POST', '/api/server/policy', {
          ...as(server),
          body: { passwordSignIn: false },
        })
      ).status,
    ).toBe(204);
    const last = await call(server, 'DELETE', '/api/server/google', {
      ...as(server),
      body: { confirmLastChannel: true },
    });
    expect(await refusalOf(last)).toEqual([409, 'passwords-off']);
    expect((await readSettings(server.db, cipher)).google).toBeDefined();
  });
});

describe('integration — server administration inventory', () => {
  test('a database failure truncates the audit download instead of calling a partial file complete', async () => {
    const server = await aServer();
    await server.db
      .insertInto('server_audit_log')
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          id: messageId(new Date(Date.UTC(2026, 10, 1, 0, 0, 0, index))),
          action: 'server.smtp_tested',
          actor_user_id: server.admin.userId,
        })),
      )
      .execute();
    const response = await call(
      server,
      'GET',
      '/api/server/audit/export?format=ndjson&action=server.smtp_tested',
      { cookie: server.admin.cookie },
    );
    if (response.body === null) throw new Error('download missing');
    const reader = response.body.getReader();
    expect((await reader.read()).done).toBe(false);
    await server.db.schema.dropTable('server_audit_log').execute();
    const failure = await reader.read().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).not.toBeNull();
  });
  test('server audit downloads walk every page without read-ahead and cancellation stops reads', async () => {
    const server = await aServer();
    await server.db
      .insertInto('server_audit_log')
      .values(
        Array.from({ length: 205 }, (_, index) => ({
          id: messageId(new Date(Date.UTC(2026, 10, 1, 0, 0, 0, index))),
          action: 'server.smtp_tested',
          actor_user_id: server.admin.userId,
        })),
      )
      .execute();
    const reads = spyOn(administrationInventory, 'listServerAudit');
    const count = (): number => reads.mock.calls.length;
    try {
      const path = '/api/server/audit/export?format=ndjson&action=server.smtp_tested';
      const answer = await call(server, 'GET', path, { cookie: server.admin.cookie });
      expect(count()).toBe(1);
      if (answer.body === null) throw new Error('download missing');
      const reader = answer.body.getReader();
      const decode = (value: unknown): string => {
        if (!(value instanceof Uint8Array)) throw new Error('Expected download bytes');
        return new TextDecoder().decode(value);
      };
      const first = await reader.read();
      expect(decode(first.value).trim().split('\n')).toHaveLength(100);
      expect(count()).toBe(1);
      let text = decode(first.value);
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decode(chunk.value);
      }
      const lines = text.trim().split('\n');
      expect(lines).toHaveLength(205);
      expect(new Set(lines).size).toBe(205);
      expect(count()).toBe(3);
      const cancelled = await call(server, 'GET', path, { cookie: server.admin.cookie });
      expect(count()).toBe(4);
      await cancelled.body?.cancel();
      expect(count()).toBe(4);
    } finally {
      reads.mockRestore();
    }
  });

  test('an aborted download closes, and losing administrator authority stops the next chunk', async () => {
    const server = await aServer();
    await server.db
      .insertInto('server_audit_log')
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          id: messageId(new Date(Date.UTC(2026, 10, 1, 0, 0, 0, index))),
          action: 'server.smtp_tested',
          actor_user_id: server.admin.userId,
        })),
      )
      .execute();
    const path = '/api/server/audit/export?format=ndjson&action=server.smtp_tested';
    const abort = new AbortController();
    const aborted = await server.app.handle(
      new Request(`${ORIGIN}${path}`, {
        signal: abort.signal,
        headers: { cookie: server.admin.cookie },
      }),
    );
    if (aborted.body === null) throw new Error('download missing');
    const abortReader = aborted.body.getReader();
    expect((await abortReader.read()).done).toBe(false);
    abort.abort();
    expect((await abortReader.read()).done).toBe(true);
    const answer = await call(server, 'GET', path, { cookie: server.admin.cookie });
    if (answer.body === null) throw new Error('download missing');
    const reader = answer.body.getReader();
    expect((await reader.read()).done).toBe(false);
    await server.db
      .updateTable('users')
      .set({ is_server_admin: false })
      .where('id', '=', server.admin.userId)
      .execute();
    const failure = await reader.read().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ body: { code: 'ROUTE_NOT_FOUND' } });
  });

  test('the server audit download applies filters, defuses CSV and records only an export request', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    await server.db
      .updateTable('users')
      .set({ display_name: '=SUM(1,2)' })
      .where('id', '=', server.admin.userId)
      .execute();
    const changed = await call(server, 'POST', '/api/server/policy', {
      cookie,
      body: { signUp: 'open' },
    });
    expect(changed.status).toBe(204);
    const filter = `action=server.sign_up_changed&actorUserId=${server.admin.userId}`;
    const answer = await call(server, 'GET', `/api/server/audit/export?format=ndjson&${filter}`, {
      cookie,
    });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toContain('application/x-ndjson');
    expect(answer.headers.get('cache-control')).toContain('no-store');
    expect(answer.headers.get('content-disposition')).toMatch(
      /^attachment; filename="server-audit-.*\.ndjson"$/,
    );
    const lines = (await answer.text())
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { action: string; actorUserId: string; actorName: string },
      );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      action: 'server.sign_up_changed',
      actorUserId: server.admin.userId,
      actorName: '=SUM(1,2)',
    });
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual([...SERVER_AUDIT_EXPORT_COLUMNS].sort());
    const csv = await call(server, 'GET', `/api/server/audit/export?format=csv&${filter}`, {
      cookie,
    });
    expect(await csv.text()).toContain('"\'=SUM(1,2)"');
    const logged = await server.db
      .selectFrom('server_audit_log')
      .selectAll()
      .where('action', '=', 'server.audit_export_requested')
      .execute();
    expect(logged).toHaveLength(2);
    expect(logged.every((row) => row.actor_user_id === server.admin.userId)).toBe(true);
    const emptyCsv = await call(
      server,
      'GET',
      '/api/server/audit/export?format=csv&action=server.account_denied',
      { cookie },
    );
    expect((await emptyCsv.text()).trim()).toBe(SERVER_AUDIT_EXPORT_COLUMNS.join(','));
    const emptyJson = await call(
      server,
      'GET',
      '/api/server/audit/export?format=ndjson&action=server.account_denied',
      { cookie },
    );
    expect(await emptyJson.text()).toBe('');
    for (const query of [
      'format=json',
      'format=csv&limit=1',
      'format=csv&from=2090-01-01T00:00:00Z&to=2020-01-01T00:00:00Z',
    ]) {
      expect(
        (await call(server, 'GET', `/api/server/audit/export?${query}`, { cookie })).status,
      ).toBe(400);
    }
  });

  test('an account denied while a batch waits cannot be admitted from its earlier selection', async () => {
    const server = await aServer();
    await server.db
      .updateTable('users')
      .set({ admission_state: 'pending' })
      .where('id', '=', server.member.userId)
      .execute();
    let enter: () => void = () => undefined;
    let resume: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const original = admissionChanges.decideAdmission;
    const blocked = spyOn(admissionChanges, 'decideAdmission').mockImplementationOnce(
      async (...args) => {
        enter();
        await released;
        return await original(...args);
      },
    );
    const pending = call(server, 'POST', '/api/server/users/approve', {
      cookie: server.admin.cookie,
      body: { userIds: [server.member.userId] },
    });
    try {
      await entered;
      await server.db
        .updateTable('users')
        .set({ admission_state: 'denied' })
        .where('id', '=', server.member.userId)
        .execute();
      resume();
      const response = await pending;
      expect(await response.json()).toEqual({
        results: [{ userId: server.member.userId, outcome: 'refused' }],
      });
      expect(
        (
          await server.db
            .selectFrom('users')
            .select('admission_state')
            .where('id', '=', server.member.userId)
            .executeTakeFirstOrThrow()
        ).admission_state,
      ).toBe('denied');
    } finally {
      resume();
      await pending;
      blocked.mockRestore();
    }
  });

  test('one bounded batch approves fifty accounts without granting administrator access', async () => {
    const server = await aServer();
    const accounts = await server.db
      .insertInto('users')
      .values(
        Array.from({ length: 50 }, (_, index) => {
          const username = `batch-${String(index)}-${crypto.randomUUID().slice(0, 8)}`;
          return {
            username,
            email: `${username}@example.test`,
            display_name: username,
            admission_state: 'pending',
            email_verified: true,
          };
        }),
      )
      .returning('id')
      .execute();
    const userIds = accounts.map((row) => row.id);
    const answer = await call(server, 'POST', '/api/server/users/approve', {
      cookie: server.admin.cookie,
      body: { userIds },
    });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({
      results: userIds.map((userId) => ({ userId, outcome: 'approved' })),
    });
    const users = await server.db
      .selectFrom('users')
      .select(['admission_state', 'is_server_admin', 'email_verified'])
      .where('id', 'in', userIds)
      .execute();
    expect(users).toHaveLength(50);
    expect(
      users.every(
        (user) =>
          user.admission_state === 'approved' && !user.is_server_admin && user.email_verified,
      ),
    ).toBe(true);
  });
  test.each([true, false])(
    'batch approval stops when authority is lost and reports an unconfirmed database failure honestly (%s)',
    async (loseAuthority) => {
      const server = await aServer();
      await server.db
        .updateTable('users')
        .set({ admission_state: 'pending' })
        .where('id', 'in', [server.member.userId, server.owner.userId])
        .execute();
      const original = admissionChanges.decideAdmission;
      const changed = spyOn(admissionChanges, 'decideAdmission').mockImplementationOnce(
        async (tx, clock, admin, id, decision, pendingOnly) => {
          if (!loseAuthority) throw new Error('private database failure');
          const ended = await original(tx, clock, admin, id, decision, pendingOnly);
          await tx
            .updateTable('users')
            .set({ is_server_admin: false })
            .where('id', '=', server.admin.userId)
            .execute();
          return ended;
        },
      );
      try {
        const ids = [server.member.userId, server.owner.userId, crypto.randomUUID()];
        const answer = await call(server, 'POST', '/api/server/users/approve', {
          cookie: server.admin.cookie,
          body: { userIds: ids },
        });
        expect(answer.status).toBe(200);
        const body: unknown = await answer.json();
        expect(body).toEqual({
          results: ids.map((userId, index) => ({
            userId,
            outcome:
              index === 0
                ? loseAuthority
                  ? 'approved'
                  : 'unconfirmed'
                : index === 1 && loseAuthority
                  ? 'refused'
                  : 'not_processed',
          })),
        });
        expect(JSON.stringify(body)).not.toContain('private database failure');
        expect(
          (
            await server.db
              .selectFrom('users')
              .select('admission_state')
              .where('id', '=', server.owner.userId)
              .executeTakeFirstOrThrow()
          ).admission_state,
        ).toBe('pending');
      } finally {
        changed.mockRestore();
      }
    },
  );

  test.each([true, false])(
    'batch cancellation stops between accounts and after authorization, without undoing committed approvals (%s)',
    async (duringAuthorization) => {
      const server = await aServer();
      await server.db
        .updateTable('users')
        .set({ admission_state: 'pending' })
        .where('id', 'in', [server.member.userId, server.owner.userId])
        .execute();
      const abort = new AbortController();
      const originalGuard = setupAuthority.requireServerAdmin;
      const originalChange = admissionChanges.decideAdmission;
      let guards = 0;
      const guard = spyOn(setupAuthority, 'requireServerAdmin').mockImplementation(
        async (...args) => {
          const authority = await originalGuard(...args);
          guards++;
          if (duringAuthorization && guards === 2) abort.abort();
          return authority;
        },
      );
      const changed = spyOn(admissionChanges, 'decideAdmission').mockImplementationOnce(
        async (...args) => {
          const ended = await originalChange(...args);
          abort.abort();
          return ended;
        },
      );
      try {
        const userIds = [server.member.userId, server.owner.userId];
        const answer = await server.app.handle(
          new Request(`${ORIGIN}/api/server/users/approve`, {
            method: 'POST',
            signal: abort.signal,
            headers: {
              cookie: server.admin.cookie,
              origin: ORIGIN,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ userIds }),
          }),
        );
        expect(answer.status).toBe(200);
        expect(await answer.json()).toEqual({
          results: userIds.map((userId, index) => ({
            userId,
            outcome: index === 0 && !duringAuthorization ? 'approved' : 'not_processed',
          })),
        });
        expect(
          (
            await server.db
              .selectFrom('users')
              .select('admission_state')
              .where('id', '=', server.member.userId)
              .executeTakeFirstOrThrow()
          ).admission_state,
        ).toBe(duringAuthorization ? 'pending' : 'approved');
      } finally {
        guard.mockRestore();
        changed.mockRestore();
      }
    },
  );
  test('batch approval is pending-only, idempotent and independently reports refused targets', async () => {
    const server = await aServer();
    await server.db
      .updateTable('users')
      .set({ admission_state: 'pending' })
      .where('id', '=', server.member.userId)
      .execute();
    await server.db
      .updateTable('users')
      .set({ admission_state: 'denied' })
      .where('id', '=', server.owner.userId)
      .execute();
    const missing = crypto.randomUUID();
    const userIds = [server.member.userId, server.owner.userId, server.admin.userId, missing];
    const response = await call(server, 'POST', '/api/server/users/approve', {
      cookie: server.admin.cookie,
      body: { userIds },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      results: userIds.map((userId, index) => ({
        userId,
        outcome: index === 0 || index === 2 ? 'approved' : 'refused',
      })),
    });
    const user = await server.db
      .selectFrom('users')
      .select(['admission_state', 'is_server_admin'])
      .where('id', '=', server.member.userId)
      .executeTakeFirstOrThrow();
    expect(user).toEqual({ admission_state: 'approved', is_server_admin: false });
    expect(
      (
        await server.db
          .selectFrom('users')
          .select('admission_state')
          .where('id', '=', server.owner.userId)
          .executeTakeFirstOrThrow()
      ).admission_state,
    ).toBe('denied');
    const again = await call(server, 'POST', '/api/server/users/approve', {
      cookie: server.admin.cookie,
      body: { userIds: [server.member.userId] },
    });
    expect(again.status).toBe(200);
    const trail = await server.db
      .selectFrom('server_audit_log')
      .select('id')
      .where('action', '=', 'server.account_approved')
      .where('target_user_id', '=', server.member.userId)
      .execute();
    expect(trail).toHaveLength(1);
    for (const body of [
      { userIds: [] },
      { userIds: [missing, missing] },
      { userIds: Array.from({ length: 51 }, () => crypto.randomUUID()) },
      { userIds: [missing], force: true },
    ]) {
      expect(
        (
          await call(server, 'POST', '/api/server/users/approve', {
            cookie: server.admin.cookie,
            body,
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await call(server, 'POST', '/api/server/users/approve', {
            cookie: server.owner.cookie,
            body,
          })
        ).status,
      ).toBe(404);
    }
  });
  test('metadata routes are absent before input is parsed for strangers, members and workspace owners', async () => {
    const server = await aServer();
    for (const cookie of [undefined, server.member.cookie, server.owner.cookie]) {
      for (const path of [
        '/api/server/overview',
        '/api/server/users?limit=invalid',
        '/api/server/workspaces?offset=1',
        '/api/server/audit?from=bad',
        '/api/server/audit/export?format=invalid',
        '/api/server/operations',
        `/api/server/users/${server.admin.userId}?after=bad`,
      ]) {
        const answer = await call(server, 'GET', path, { cookie });
        expect(answer.status).toBe(404);
        expect(answer.headers.get('cache-control')).toContain('no-store');
      }
      const answer = await call(server, 'POST', `/api/server/users/${server.member.userId}/admin`, {
        cookie,
        body: { isServerAdmin: true },
      });
      expect(answer.status).toBe(404);
    }
  });

  test('user inventory is paginated, filters are enforced, details include membership without content', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    const first = await call(server, 'GET', '/api/server/users?limit=1', { cookie });
    expect(first.status).toBe(200);
    const page = (await first.json()) as ServerUserPage;
    expect(page.data).toHaveLength(1);
    expect(page.nextCursor).toBe(page.data[0]?.id ?? 'missing');
    const next = await call(
      server,
      'GET',
      `/api/server/users?limit=1&after=${page.nextCursor ?? ''}`,
      { cookie },
    );
    const second = (await next.json()) as ServerUserPage;
    expect(second.data[0]?.id).not.toBe(page.data[0]?.id);
    const admins = await call(server, 'GET', '/api/server/users?status=admins', { cookie });
    const list = (await admins.json()) as ServerUserPage;
    expect(list.data.map((user) => user.id)).toEqual([server.admin.userId]);
    const details = await call(server, 'GET', `/api/server/users/${server.owner.userId}`, {
      cookie,
    });
    expect(details.status).toBe(200);
    const detail = (await details.json()) as ServerUserDetail;
    expect(detail.memberships[0]?.role).toBe('owner');
    expect(detail.activeSessions).toBe(1);
    expect(JSON.stringify(detail)).not.toContain('token_hash');
    for (const query of ['limit=0', 'limit=101', 'q=a&q=b', 'offset=1', 'status=deleted']) {
      expect((await call(server, 'GET', `/api/server/users?${query}`, { cookie })).status).toBe(
        400,
      );
    }
  });

  test('quota changes reuse upload accounting, are audited and reject unsafe integers', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    const listed = await call(server, 'GET', '/api/server/workspaces', { cookie });
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as ServerWorkspacePage;
    const workspace = page.data[0];
    expect(workspace).toBeDefined();
    if (workspace === undefined) throw new Error('workspace fixture missing');
    expect(workspace.ownerCount).toBe(1);
    expect(workspace.owners[0]?.id).toBe(server.owner.userId);
    await server.db
      .insertInto('attachments')
      .values({
        id: messageId(systemClock.now()),
        file_name: 'private-name.txt',
        mime_type: 'text/plain',
        size_bytes: '2048',
        storage_key: 'pending-file',
        uploader_id: server.owner.userId,
        workspace_id: workspace.id,
      })
      .execute();
    const path = `/api/server/workspaces/${workspace.id}/quota`;
    expect((await call(server, 'POST', path, { cookie, body: { quotaBytes: 1024 } })).status).toBe(
      204,
    );
    expect((await call(server, 'POST', path, { cookie, body: { quotaBytes: 1024 } })).status).toBe(
      204,
    );
    expect(
      (
        await call(server, 'POST', path, {
          cookie,
          body: { quotaBytes: Number.MAX_SAFE_INTEGER + 1 },
        })
      ).status,
    ).toBe(400);
    const full = await call(server, 'GET', '/api/server/workspaces?status=full', { cookie });
    const usage = (await full.json()) as ServerWorkspacePage;
    expect(usage.data[0]?.usedBytes).toBe('2048');
    expect(JSON.stringify(usage)).not.toContain('private-name');
    const changed = await server.db
      .selectFrom('workspaces')
      .select('storage_quota_bytes')
      .where('id', '=', workspace.id)
      .executeTakeFirstOrThrow();
    expect(changed.storage_quota_bytes).toBe('1024');
    const audit = await call(
      server,
      'GET',
      '/api/server/audit?action=server.quota_changed&limit=1',
      { cookie },
    );
    const entries = (await audit.json()) as ServerAuditPage;
    expect(entries.data).toHaveLength(1);
    expect(entries.nextCursor).toBeNull();
    expect(entries.data[0]?.actorUserId).toBe(server.admin.userId);
    expect(entries.data[0]?.targetWorkspaceId).toBe(workspace.id);
  });

  describeNeeding('issues')('the modules a workspace is granted (D-289)', () => {
    const granting = async (): Promise<{
      server: Server;
      workspaceId: string;
      path: string;
      rows: () => Promise<
        { module: string; state: string; source: string; changed_by: string | null }[]
      >;
    }> => {
      const server = await aServer();
      const listed = (await (
        await call(server, 'GET', '/api/server/workspaces', { cookie: server.admin.cookie })
      ).json()) as ServerWorkspacePage;
      const workspaceId = listed.data[0]?.id ?? '';
      expect(workspaceId).not.toBe('');
      return {
        server,
        workspaceId,
        path: `/api/server/workspaces/${workspaceId}/modules`,
        rows: async () =>
          await server.db
            .selectFrom('workspace_modules')
            .select(['module', 'state', 'source', 'changed_by'])
            .where('workspace_id', '=', workspaceId)
            .execute(),
      };
    };
    const moduleTrail = async (
      server: Server,
    ): Promise<{ action: string; target_module: string | null }[]> =>
      await server.db
        .selectFrom('server_audit_log')
        .select(['action', 'target_module'])
        .where('action', 'like', 'server.module_%')
        .orderBy('id')
        .execute();

    test('only the server administrator writes: the workspace’s owner, a member and nobody get one answer and nothing is written', async () => {
      const { server, path, rows } = await granting();
      const answers: string[] = [];
      for (const cookie of [server.owner.cookie, server.member.cookie, undefined]) {
        const response = await call(server, 'POST', path, {
          ...(cookie === undefined ? {} : { cookie }),
          body: { module: 'issues', state: 'on' },
        });
        const { error } = (await response.json()) as { error: { code: string; message: string } };
        answers.push(`${String(response.status)} ${error.code} ${error.message}`);
      }
      expect(new Set(answers).size).toBe(1);
      expect(answers[0]).toStartWith('404 ');
      expect(await rows()).toEqual([]);
      expect(await moduleTrail(server)).toEqual([]);
    });

    test('a grant is written with who and how, recorded on the trail by id, and again is the same', async () => {
      const { server, workspaceId, path, rows } = await granting();
      const cookie = server.admin.cookie;

      for (let again = 0; again < 2; again++)
        expect(
          (await call(server, 'POST', path, { cookie, body: { module: 'issues', state: 'off' } }))
            .status,
        ).toBe(204);
      expect(await rows()).toEqual([
        { module: 'issues', state: 'off', source: 'operator', changed_by: server.admin.userId },
      ]);
      // The trail has one entry for two identical requests, by module id and without a word of the value.
      expect(await moduleTrail(server)).toEqual([
        { action: 'server.module_withdrawn', target_module: 'issues' },
      ]);
      const entries = (await (
        await call(server, 'GET', `/api/server/audit?targetWorkspaceId=${workspaceId}`, { cookie })
      ).json()) as ServerAuditPage;
      expect(entries.data[0]).toMatchObject({
        targetModule: 'issues',
        targetWorkspaceId: workspaceId,
      });

      // The member is refused the module's routes until the row is taken away.
      expect(
        (
          await call(server, 'GET', `/api/workspaces/${workspaceId}/issues`, {
            cookie: server.owner.cookie,
          })
        ).status,
      ).toBe(404);
      expect(
        (await call(server, 'POST', path, { cookie, body: { module: 'issues', state: 'inherit' } }))
          .status,
      ).toBe(204);
      expect(await rows()).toEqual([]);
      expect(
        (
          await call(server, 'GET', `/api/workspaces/${workspaceId}/issues`, {
            cookie: server.owner.cookie,
          })
        ).status,
      ).toBe(200);
      expect((await moduleTrail(server)).map(({ action }) => action)).toEqual([
        'server.module_withdrawn',
        'server.module_reset',
      ]);
      // Taking away what is not there records nothing.
      await call(server, 'POST', path, { cookie, body: { module: 'issues', state: 'inherit' } });
      expect(await moduleTrail(server)).toHaveLength(2);
    });

    test('refuses a module the build does not carry, one no workspace is granted, an end that has passed, a workspace that is not there and a body that is not one', async () => {
      const { server, workspaceId, path, rows } = await granting();
      const cookie = server.admin.cookie;
      const field = async (body: unknown): Promise<[number, string[]]> => {
        const response = await call(server, 'POST', path, { cookie, body });
        const { error } = (await response.json()) as {
          error: { details?: { fields?: Record<string, string> } };
        };
        return [response.status, Object.keys(error.details?.fields ?? {})];
      };
      expect(await field({ module: 'tasks', state: 'on' })).toEqual([400, ['module']]);
      expect(await field({ module: 'chat', state: 'off' })).toEqual([400, ['module']]);
      expect(await field({ module: 'Issues', state: 'on' })).toEqual([400, ['module']]);
      expect(await field({ module: 'issues', state: 'maybe' })).toEqual([400, ['state']]);
      expect(
        await field({ module: 'issues', state: 'on', validUntil: '2000-01-01T00:00:00Z' }),
      ).toEqual([400, ['validUntil']]);
      expect(
        await field({ module: 'issues', state: 'inherit', validUntil: '2999-01-01T00:00:00Z' }),
      ).toEqual([400, ['validUntil']]);
      expect((await field({ module: 'issues', state: 'on', extra: true }))[0]).toBe(400);
      expect((await field({}))[0]).toBe(400);
      const unknown = await call(
        server,
        'POST',
        `/api/server/workspaces/${crypto.randomUUID()}/modules`,
        {
          cookie,
          body: { module: 'issues', state: 'on' },
        },
      );
      expect(unknown.status).toBe(404);
      expect(
        (
          await call(server, 'POST', '/api/server/workspaces/not-a-uuid/modules', {
            cookie,
            body: { module: 'issues', state: 'on' },
          })
        ).status,
      ).toBe(400);
      expect(await rows()).toEqual([]);
      expect(await moduleTrail(server)).toEqual([]);
      // A grant with an end in the future is kept with it and shown.
      const until = new Date(Date.now() + 3_600_000).toISOString();
      expect(
        (
          await call(server, 'POST', path, {
            cookie,
            body: { module: 'issues', state: 'on', validUntil: until },
          })
        ).status,
      ).toBe(204);
      const kept = await server.db
        .selectFrom('workspace_modules')
        .select('valid_until')
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirstOrThrow();
      expect(kept.valid_until?.toISOString()).toBe(until);
    });

    test('the workspace list says what each workspace has been told of each module, what that comes to, and who said it', async () => {
      const { server, workspaceId, path } = await granting();
      const cookie = server.admin.cookie;
      const modulesOf = async (): Promise<ServerWorkspacePage['data'][number]['modules']> =>
        (
          (await (
            await call(server, 'GET', '/api/server/workspaces', { cookie })
          ).json()) as ServerWorkspacePage
        ).data.find(({ id }) => id === workspaceId)?.modules ?? [];
      // Nothing said: an open server gives it, and chat, which is not a grant, is not listed.
      expect(await modulesOf()).toEqual([
        {
          module: 'issues',
          state: 'inherit',
          effective: true,
          validUntil: null,
          source: null,
          running: true,
        },
      ]);
      await call(server, 'POST', path, { cookie, body: { module: 'issues', state: 'off' } });
      expect(await modulesOf()).toEqual([
        {
          module: 'issues',
          state: 'off',
          effective: false,
          validUntil: null,
          source: 'operator',
          running: true,
        },
      ]);
      const until = new Date(Date.now() + 3_600_000).toISOString();
      await call(server, 'POST', path, {
        cookie,
        body: { module: 'issues', state: 'on', validUntil: until },
      });
      expect((await modulesOf())[0]).toMatchObject({
        state: 'on',
        effective: true,
        validUntil: until,
      });
      // A row that has run out is no row: the list shows what the server would do.
      await server.db
        .updateTable('workspace_modules')
        .set({ valid_until: new Date(Date.now() - 1_000) })
        .where('workspace_id', '=', workspaceId)
        .execute();
      expect((await modulesOf())[0]).toMatchObject({
        state: 'inherit',
        source: null,
        validUntil: null,
      });
    });

    test('a restriction waits for every node of the cluster to read grants, and a grant does not', async () => {
      const server = await aServer({ peersBehind: () => Promise.resolve(1) });
      const workspaceId = (
        (await (
          await call(server, 'GET', '/api/server/workspaces', { cookie: server.admin.cookie })
        ).json()) as ServerWorkspacePage
      ).data[0]?.id;
      const path = `/api/server/workspaces/${workspaceId ?? ''}/modules`;
      const cookie = server.admin.cookie;
      const refused = await call(server, 'POST', path, {
        cookie,
        body: { module: 'issues', state: 'off' },
      });
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
        'PEERS_BEHIND',
      );
      expect(
        await server.db
          .selectFrom('workspace_modules')
          .selectAll()
          .where('module', '=', 'issues')
          .execute(),
      ).toEqual([]);
      expect(
        (await call(server, 'POST', path, { cookie, body: { module: 'issues', state: 'on' } }))
          .status,
      ).toBe(204);
    });

    test('two administrators writing at once leave the row the trail ends on, and every change is on the trail', async () => {
      const { server, path, rows } = await granting();
      await server.db
        .updateTable('users')
        .set({ email_verified: true })
        .where('id', '=', server.member.userId)
        .execute();
      await call(server, 'POST', `/api/server/users/${server.member.userId}/admin`, {
        cookie: server.admin.cookie,
        body: { isServerAdmin: true },
      });
      const states = ['on', 'off'] as const;
      const answers = await Promise.all(
        [server.admin.cookie, server.member.cookie].map(
          async (cookie, at) =>
            await call(server, 'POST', path, {
              cookie,
              body: { module: 'issues', state: states[at] },
            }),
        ),
      );
      expect(answers.map((answer) => answer.status)).toEqual([204, 204]);
      const trailed = await moduleTrail(server);
      expect(trailed).toHaveLength(2);
      const last = trailed.at(-1)?.action === 'server.module_granted' ? 'on' : 'off';
      expect((await rows()).map(({ state }) => state)).toEqual([last]);
    });
  });

  test('concurrent administrators cannot remove every administrator; a demotion loses authority immediately', async () => {
    const server = await aServer();
    await server.db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', server.member.userId)
      .execute();
    const grant = await call(server, 'POST', `/api/server/users/${server.member.userId}/admin`, {
      cookie: server.admin.cookie,
      body: { isServerAdmin: true },
    });
    expect(grant.status).toBe(204);
    const answers = await Promise.all([
      call(server, 'POST', `/api/server/users/${server.admin.userId}/admin`, {
        cookie: server.admin.cookie,
        body: { isServerAdmin: false },
      }),
      call(server, 'POST', `/api/server/users/${server.member.userId}/admin`, {
        cookie: server.member.cookie,
        body: { isServerAdmin: false },
      }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([204, 403]);
    const remaining = await server.db
      .selectFrom('users')
      .select('id')
      .where('is_server_admin', '=', true)
      .where('deleted_at', 'is', null)
      .execute();
    expect(remaining).toHaveLength(1);
    const demotedCookie =
      remaining[0]?.id === server.admin.userId ? server.member.cookie : server.admin.cookie;
    expect(
      (await call(server, 'GET', '/api/server/overview', { cookie: demotedCookie })).status,
    ).toBe(404);
  });

  test('session revocation removes the target sessions and records the actor', async () => {
    const server = await aServer();
    const answer = await call(
      server,
      'POST',
      `/api/server/users/${server.member.userId}/revoke-sessions`,
      { cookie: server.admin.cookie, body: {} },
    );
    expect(answer.status).toBe(204);
    const sessions = await server.db
      .selectFrom('sessions')
      .select('id')
      .where('user_id', '=', server.member.userId)
      .where('revoked_at', 'is', null)
      .execute();
    expect(sessions).toHaveLength(0);
    expect((await trail(server)).map((entry) => entry.action)).toContain('server.sessions_revoked');
  });

  test('overview and jobs use live metadata and do not expose stored raw errors or credentials', async () => {
    const server = await aServer({ noWorkspace: true });
    const cookie = server.admin.cookie;
    await server.db
      .insertInto('job_runs')
      .values({
        job_name: 'sweep:sessions',
        consecutive_failures: 2,
        last_error: 'postgres://root:secret@example/db',
        last_success_at: new Date(0),
      })
      .execute();
    const response = await call(server, 'GET', '/api/server/overview', { cookie });
    expect(response.status).toBe(200);
    const overview = (await response.json()) as ServerOverview;
    expect(overview.users).toBe(3);
    expect(overview.admins).toBe(1);
    expect(overview.workspaces).toBe(0);
    const operations = await call(server, 'GET', '/api/server/operations', { cookie });
    expect(operations.status).toBe(200);
    const result = (await operations.json()) as ServerOperations;
    expect(result.jobs.find((job) => job.name === 'sweep:sessions')?.status).toBe('overdue');
    expect(result.jobs.find((job) => job.name === 'sweep:orphans')?.status).toBe('never');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});

describe('integration — saved mail relay testing', () => {
  test('sends only to the verified requesting administrator, reuses saved credentials and persists a safe receipt', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    expect((await call(server, 'POST', '/api/server/mail-test', { cookie, body: {} })).status).toBe(
      403,
    );
    const relay = await aRelay();
    expect(
      (await call(server, 'POST', '/api/server/smtp', { cookie, body: smtpBody(relay) })).status,
    ).toBe(200);
    expect((await call(server, 'POST', '/api/server/mail-test', { cookie, body: {} })).status).toBe(
      403,
    );
    await server.db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', server.admin.userId)
      .execute();
    const before = relay.received.length;
    expect(
      (
        await call(server, 'POST', '/api/server/mail-test', {
          cookie,
          body: { to: 'somebody@example.test' },
        })
      ).status,
    ).toBe(400);
    expect(relay.received).toHaveLength(before);
    const answer = await call(server, 'POST', '/api/server/mail-test', { cookie, body: {} });
    expect(answer.status).toBe(200);
    const receipt = (await answer.json()) as ServerMailTest;
    expect(receipt.accepted).toBe(true);
    expect(receipt.reason).toBeNull();
    expect(JSON.stringify(receipt)).not.toContain(RELAY_PASS);
    expect(relay.received).toHaveLength(before + 1);
    expect(relay.received.at(-1)?.to).toEqual([server.admin.email]);
    const status = await call(server, 'GET', '/api/server/mail-test', { cookie });
    expect(await status.json()).toEqual({ lastTest: receipt });
    expect((await trail(server)).map((entry) => entry.action)).toContain('server.smtp_tested');
    expect(
      (
        await call(server, 'POST', '/api/server/mail-test', {
          cookie: server.member.cookie,
          body: {},
        })
      ).status,
    ).toBe(404);
  });
});

describe('integration — admission and server identity', () => {
  const preferences = {
    displayName: 'Research server',
    supportUrl: 'https://support.example.test/help',
    allowedEmailDomains: ['example.test'],
    requireAccountApproval: true,
  };
  test('new OAuth accounts persist pending, reach only their own status, and become usable after audited approval', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    expect(
      (await call(server, 'POST', '/api/server/policy', { cookie, body: { signUp: 'open' } }))
        .status,
    ).toBe(204);
    expect(
      (await call(server, 'POST', '/api/server/github', { cookie, body: GITHUB_OK })).status,
    ).toBe(200);
    expect(
      (await call(server, 'POST', '/api/server/preferences', { cookie, body: preferences })).status,
    ).toBe(204);
    const signedIn = await signInWithGitHub(server.app, ORIGIN, server.github);
    const pending = await server.db
      .selectFrom('users')
      .select(['id', 'admission_state'])
      .where('email', '=', server.person.email.toLowerCase())
      .executeTakeFirstOrThrow();
    expect(pending.admission_state).toBe('pending');
    expect((await call(server, 'GET', '/api/me', { cookie: cookiesFrom(signedIn) })).status).toBe(
      401,
    );
    const status = await call(server, 'GET', '/api/admission', { cookie: cookiesFrom(signedIn) });
    expect(await status.json()).toEqual({ state: 'pending' });
    expect(
      (await call(server, 'GET', '/api/server/users', { cookie: cookiesFrom(signedIn) })).status,
    ).toBe(404);
    // The new policy does not eject previously admitted accounts.
    expect((await call(server, 'GET', '/api/me', { cookie: server.member.cookie })).status).toBe(
      200,
    );
    expect(
      (
        await call(server, 'POST', `/api/server/users/${pending.id}/admission`, {
          cookie,
          body: { decision: 'approved' },
        })
      ).status,
    ).toBe(204);
    expect((await call(server, 'GET', '/api/me', { cookie: cookiesFrom(signedIn) })).status).toBe(
      200,
    );
    expect((await trail(server)).map((row) => row.action)).toContain('server.account_approved');
    const publicInfo = await call(server, 'GET', '/api/instance');
    expect(await publicInfo.json()).toEqual(preferences);
  });

  test('a domain restriction is enforced at account creation, cannot be bypassed by a client, and matches exact domains', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    await call(server, 'POST', '/api/server/policy', { cookie, body: { signUp: 'open' } });
    await call(server, 'POST', '/api/server/github', { cookie, body: GITHUB_OK });
    expect(
      (
        await call(server, 'POST', '/api/server/preferences', {
          cookie,
          body: { ...preferences, allowedEmailDomains: ['other.test'] },
        })
      ).status,
    ).toBe(204);
    await signInWithGitHub(server.app, ORIGIN, server.github);
    const refused = await server.db
      .selectFrom('users')
      .select('id')
      .where('email', '=', server.person.email.toLowerCase())
      .executeTakeFirst();
    expect(refused).toBeUndefined();
    const bad = await call(server, 'POST', '/auth/sign-up/email', {
      body: {
        name: 'Applicant',
        email: 'applicant@example.test',
        password: 'Safe-test-password-2026!',
        admissionState: 'approved',
        admissionRequiresVerifiedEmail: false,
      },
    });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(
      await server.db
        .selectFrom('users')
        .select('id')
        .where('email', '=', 'applicant@example.test')
        .execute(),
    ).toHaveLength(0);
    for (const supportUrl of [
      'javascript:alert(1)',
      'https://user:password@example.test',
      'mailto:me@example.test?body=secret',
    ]) {
      expect(
        (
          await call(server, 'POST', '/api/server/preferences', {
            cookie,
            body: { ...preferences, supportUrl },
          })
        ).status,
      ).toBe(400);
    }
  });

  test('unverified restricted accounts are held back and denied applicants lose all sessions', async () => {
    const server = await aServer();
    await server.db
      .updateTable('users')
      .set({ admission_requires_verified_email: true })
      .where('id', '=', server.member.userId)
      .execute();
    expect((await call(server, 'GET', '/api/me', { cookie: server.member.cookie })).status).toBe(
      401,
    );
    expect(
      await (await call(server, 'GET', '/api/admission', { cookie: server.member.cookie })).json(),
    ).toEqual({ state: 'verify-email' });
    await server.db
      .updateTable('users')
      .set({ admission_state: 'pending' })
      .where('id', '=', server.member.userId)
      .execute();
    const denied = await call(
      server,
      'POST',
      `/api/server/users/${server.member.userId}/admission`,
      { cookie: server.admin.cookie, body: { decision: 'denied' } },
    );
    expect(denied.status).toBe(204);
    expect(
      await server.db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', '=', server.member.userId)
        .execute(),
    ).toHaveLength(0);
    expect(await (await call(server, 'GET', '/api/admission')).json()).toEqual({ state: null });
  });
});

describe('integration — administrator authority during a settings change', () => {
  test('an administrator demoted while waiting to save cannot commit settings with stale authority', async () => {
    const server = await aServer();
    await server.db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', server.member.userId)
      .execute();
    expect(
      (
        await call(server, 'POST', `/api/server/users/${server.member.userId}/admin`, {
          cookie: server.admin.cookie,
          body: { isServerAdmin: true },
        })
      ).status,
    ).toBe(204);
    const release = Promise.withResolvers<undefined>();
    const held = Promise.withResolvers<undefined>();
    const entered = Promise.withResolvers<undefined>();
    const occupying = server.holder.exclusively(async () => {
      held.resolve(undefined);
      await release.promise;
    });
    await held.promise;
    const original = server.holder.exclusively.bind(server.holder);
    const spy = spyOn(server.holder, 'exclusively').mockImplementation(
      async <T>(work: () => Promise<T>): Promise<T> => {
        entered.resolve(undefined);
        return await original(work);
      },
    );
    try {
      const pending = call(server, 'POST', '/api/server/policy', {
        cookie: server.admin.cookie,
        body: { signUp: 'open' },
      });
      await entered.promise;
      expect(
        (
          await call(server, 'POST', `/api/server/users/${server.admin.userId}/admin`, {
            cookie: server.member.cookie,
            body: { isServerAdmin: false },
          })
        ).status,
      ).toBe(204);
      release.resolve(undefined);
      expect((await pending).status).toBe(404);
      expect((await readSettings(server.db, cipher)).signUp).toBe('invite-only');
    } finally {
      spy.mockRestore();
      release.resolve(undefined);
      await occupying;
    }
  });
});

describe('integration — administration read budgets', () => {
  test('inventory navigation does not spend the provider/write budget, and metadata reads remain bounded', async () => {
    const server = await aServer({ limits: 'real', clock: fixedClock(systemClock.now()) });
    const cookie = server.admin.cookie;
    for (let at = 0; at < 60; at++) {
      expect((await call(server, 'GET', '/api/server/users?limit=1', { cookie })).status).toBe(200);
    }
    expect((await call(server, 'GET', '/api/server/users?limit=1', { cookie })).status).toBe(429);
    // Provider/settings reads retain their old budget, independent of the inventory's.
    expect((await call(server, 'GET', '/api/server/settings', { cookie })).status).toBe(200);
  });
});

describe('integration — admission across sign-in paths', () => {
  test.each(['oidc', 'google'] as const)(
    '%s cannot bypass approval even with a verified allowed-domain identity',
    async (provider) => {
      const server = await aServer();
      const cookie = server.admin.cookie;
      await call(server, 'POST', '/api/server/policy', { cookie, body: { signUp: 'open' } });
      expect(
        (
          await call(server, 'POST', '/api/server/preferences', {
            cookie,
            body: { allowedEmailDomains: ['gmail.com'], requireAccountApproval: true },
          })
        ).status,
      ).toBe(204);
      expect(
        (
          await call(server, 'POST', `/api/server/${provider}`, {
            cookie,
            body: {
              ...OIDC_STUB_CREDENTIALS,
              ...(provider === 'oidc' ? { issuer: server.google.issuer(), name: 'Identity' } : {}),
            },
          })
        ).status,
      ).toBe(200);
      const response =
        provider === 'oidc'
          ? await signInWithOidc(server.app, ORIGIN, server.google)
          : await signInWithGoogle(server.app, ORIGIN, server.google);
      const signed = cookiesFrom(response);
      const status = await call(server, 'GET', '/api/admission', { cookie: signed });
      expect(await status.json()).toEqual({ state: 'pending' });
      expect((await call(server, 'GET', '/api/me', { cookie: signed })).status).toBe(401);
      const person = await server.db
        .selectFrom('users')
        .select(['admission_state', 'email_verified'])
        .where('email', '=', 'grace@gmail.com')
        .executeTakeFirstOrThrow();
      expect(person).toEqual({ admission_state: 'pending', email_verified: true });
    },
  );

  test('an invitation passport permits registration but neither approval nor workspace access', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    await call(server, 'POST', '/api/server/github', { cookie, body: GITHUB_OK });
    await call(server, 'POST', '/api/server/preferences', {
      cookie,
      body: { allowedEmailDomains: ['example.test'], requireAccountApproval: true },
    });
    const workspace = await server.db
      .selectFrom('workspaces')
      .select('id')
      .where('created_by', '=', server.owner.userId)
      .executeTakeFirstOrThrow();
    const made = await call(server, 'POST', `/api/workspaces/${workspace.id}/invitations`, {
      cookie: server.owner.cookie,
      body: {},
    });
    expect(made.status).toBe(201);
    const { token } = (await made.json()) as { token: string };
    const passport = await call(server, 'POST', '/api/invitations/passport', { body: { token } });
    expect(passport.status).toBe(204);
    const signed = await returnFromGitHub(
      server.app,
      ORIGIN,
      await startGitHubSignIn(server.app, ORIGIN, server.github, cookiesFrom(passport)),
    );
    const entrant = cookiesFrom(signed);
    expect(await (await call(server, 'GET', '/api/admission', { cookie: entrant })).json()).toEqual(
      { state: 'pending' },
    );
    expect(
      (await call(server, 'POST', '/api/invitations/accept', { cookie: entrant, body: { token } }))
        .status,
    ).toBe(401);
  });

  test('a verified email link makes an identity-only pending account until an administrator approves it', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    const relay = await aRelay();
    await call(server, 'POST', '/api/server/smtp', { cookie, body: smtpBody(relay) });
    await call(server, 'POST', '/api/server/policy', { cookie, body: { signUp: 'open' } });
    await call(server, 'POST', '/api/server/preferences', {
      cookie,
      body: { allowedEmailDomains: ['example.test'], requireAccountApproval: true },
    });
    const email = 'applicant@example.test';
    expect(
      (await call(server, 'POST', '/auth/email', { body: { email, locale: 'en' } })).status,
    ).toBe(202);
    await server.app.settled();
    await server.holder.sends.flush();
    const data =
      relay.received
        .find((letter) => letter.to.includes(email))
        ?.data.replace(/=\r?\n/g, '')
        .replace(/=3D/g, '=') ?? '';
    const token = /#([0-9a-f]{64})/.exec(data)?.[1];
    expect(token).toBeDefined();
    const consumed = await call(server, 'POST', '/auth/email/consume', { body: { token } });
    expect(consumed.status).toBe(204);
    const applicant = cookiesFrom(consumed);
    expect(
      await (await call(server, 'GET', '/api/admission', { cookie: applicant })).json(),
    ).toEqual({ state: 'pending' });
    expect((await call(server, 'GET', '/api/me', { cookie: applicant })).status).toBe(401);
    const row = await server.db
      .selectFrom('users')
      .select(['id', 'email_verified'])
      .where('email', '=', email)
      .executeTakeFirstOrThrow();
    expect(row.email_verified).toBe(true);
    expect(
      (
        await call(server, 'POST', `/api/server/users/${row.id}/admission`, {
          cookie,
          body: { decision: 'approved' },
        })
      ).status,
    ).toBe(204);
    expect((await call(server, 'GET', '/api/me', { cookie: applicant })).status).toBe(200);
  });
});

describe('integration — administration filters and refusal states', () => {
  test('metadata search is literal, statuses belong to accounts, and details have bounded membership pages', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    await server.db
      .updateTable('users')
      .set({ display_name: '100% research', suspended_at: clockNow(), last_seen_at: clockNow() })
      .where('id', '=', server.member.userId)
      .execute();
    const search = await call(server, 'GET', '/api/server/users?q=%25&status=suspended', {
      cookie,
    });
    const people = (await search.json()) as ServerUserPage;
    expect(people.data.map((person) => person.id)).toEqual([server.member.userId]);
    expect(people.data[0]?.lastSeenAt).not.toBeNull();
    const active = await call(server, 'GET', '/api/server/users?status=active', { cookie });
    expect(
      ((await active.json()) as ServerUserPage).data.every((person) => person.suspendedAt === null),
    ).toBe(true);
    const workspaces = Array.from({ length: 50 }, (_, index) => ({
      id: crypto.randomUUID(),
      name: `Inventory ${String(index)}`,
      slug: `inventory-${String(index)}`,
      created_by: server.owner.userId,
    }));
    await server.db.insertInto('workspaces').values(workspaces).execute();
    await server.db
      .insertInto('workspace_members')
      .values(
        workspaces.map((workspace) => ({
          workspace_id: workspace.id,
          user_id: server.owner.userId,
          role: 'owner' as const,
        })),
      )
      .execute();
    const first = (await (
      await call(server, 'GET', `/api/server/users/${server.owner.userId}`, { cookie })
    ).json()) as ServerUserDetail;
    expect(first.memberships).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = (await (
      await call(
        server,
        'GET',
        `/api/server/users/${server.owner.userId}?after=${first.nextCursor ?? ''}`,
        { cookie },
      )
    ).json()) as ServerUserDetail;
    expect(second.memberships).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const deleted = workspaces[0];
    if (deleted === undefined) throw new Error('fixture missing');
    const removedAt = clockNow();
    await server.db
      .updateTable('workspaces')
      .set({ deleted_at: removedAt, purge_started_at: removedAt, purged_at: removedAt })
      .where('id', '=', deleted.id)
      .execute();
    const page = (await (
      await call(server, 'GET', `/api/server/workspaces?q=Inventory&status=deleted&limit=1`, {
        cookie,
      })
    ).json()) as ServerWorkspacePage;
    expect(page.data[0]?.id).toBe(deleted.id);
    expect(page.data[0]?.purgedAt).not.toBeNull();
    const live = (await (
      await call(server, 'GET', '/api/server/workspaces?status=active&limit=1', { cookie })
    ).json()) as ServerWorkspacePage;
    expect(live.nextCursor).not.toBeNull();
    const next = (await (
      await call(
        server,
        'GET',
        `/api/server/workspaces?status=active&limit=1&after=${live.nextCursor ?? ''}`,
        { cookie },
      )
    ).json()) as ServerWorkspacePage;
    expect(next.data[0]?.id).not.toBe(live.data[0]?.id);
    expect(
      (await call(server, 'GET', `/api/server/users/${crypto.randomUUID()}`, { cookie })).status,
    ).toBe(404);
  });

  test('audit pages filter action, actor, target and dates, and refuse a reversed date range', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    await call(server, 'POST', '/api/server/policy', { cookie, body: { signUp: 'open' } });
    await call(server, 'POST', '/api/server/preferences', {
      cookie,
      body: { displayName: 'Renamed' },
    });
    await server.db
      .updateTable('users')
      .set({ email_verified: true })
      .where('id', '=', server.member.userId)
      .execute();
    await call(server, 'POST', `/api/server/users/${server.member.userId}/admin`, {
      cookie,
      body: { isServerAdmin: true },
    });
    const first = (await (
      await call(
        server,
        'GET',
        '/api/server/audit?limit=1&from=2020-01-01T00:00:00Z&to=2090-01-01T00:00:00Z',
        { cookie },
      )
    ).json()) as ServerAuditPage;
    expect(first.nextCursor).not.toBeNull();
    const older = (await (
      await call(server, 'GET', `/api/server/audit?limit=1&after=${first.nextCursor ?? ''}`, {
        cookie,
      })
    ).json()) as ServerAuditPage;
    expect(older.data[0]?.id).not.toBe(first.data[0]?.id);
    const filtered = (await (
      await call(
        server,
        'GET',
        `/api/server/audit?action=server.admin_granted&actorUserId=${server.admin.userId}&targetUserId=${server.member.userId}`,
        { cookie },
      )
    ).json()) as ServerAuditPage;
    expect(filtered.data).toHaveLength(1);
    const none = (await (
      await call(server, 'GET', `/api/server/audit?targetWorkspaceId=${crypto.randomUUID()}`, {
        cookie,
      })
    ).json()) as ServerAuditPage;
    expect(none.data).toHaveLength(0);
    expect(
      (
        await call(
          server,
          'GET',
          '/api/server/audit?from=2090-01-01T00:00:00Z&to=2020-01-01T00:00:00Z',
          { cookie },
        )
      ).status,
    ).toBe(400);
  });

  test('sensitive changes refuse unavailable targets and unsafe grants; repeated grants do not add audit entries', async () => {
    const server = await aServer();
    const cookie = server.admin.cookie;
    const missing = crypto.randomUUID();
    for (const path of [
      `/api/server/users/${missing}/admin`,
      `/api/server/users/${missing}/revoke-sessions`,
      `/api/server/workspaces/${missing}/quota`,
      `/api/server/users/${missing}/admission`,
    ]) {
      const body = path.endsWith('/admin')
        ? { isServerAdmin: true }
        : path.endsWith('/quota')
          ? { quotaBytes: 0 }
          : path.endsWith('/admission')
            ? { decision: 'approved' }
            : {};
      expect((await call(server, 'POST', path, { cookie, body })).status).toBe(404);
    }
    const rolePath = `/api/server/users/${server.member.userId}/admin`;
    expect(
      (await call(server, 'POST', rolePath, { cookie, body: { isServerAdmin: true } })).status,
    ).toBe(403);
    await server.db
      .updateTable('users')
      .set({ email_verified: true, suspended_at: clockNow() })
      .where('id', '=', server.member.userId)
      .execute();
    expect(
      (await call(server, 'POST', rolePath, { cookie, body: { isServerAdmin: true } })).status,
    ).toBe(403);
    await server.db
      .updateTable('users')
      .set({ suspended_at: null })
      .where('id', '=', server.member.userId)
      .execute();
    for (let at = 0; at < 2; at++)
      expect(
        (await call(server, 'POST', rolePath, { cookie, body: { isServerAdmin: true } })).status,
      ).toBe(204);
    expect(
      (await trail(server)).filter((row) => row.action === 'server.admin_granted'),
    ).toHaveLength(1);
    expect(
      (
        await call(server, 'POST', '/api/server/preferences', {
          cookie,
          body: { supportUrl: 'not a URL' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(server, 'POST', '/api/server/preferences', {
          cookie,
          body: { displayName: '  ' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(server, 'POST', '/api/server/preferences', {
          cookie,
          body: { displayName: 'bad\u0001name' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call(server, 'POST', '/api/server/preferences', {
          cookie,
          body: { supportUrl: 'mailto:support@example.test' },
        })
      ).status,
    ).toBe(204);
    const before = (await trail(server)).length;
    expect(
      (
        await call(server, 'POST', '/api/server/preferences', {
          cookie,
          body: { supportUrl: 'mailto:support@example.test' },
        })
      ).status,
    ).toBe(204);
    expect((await trail(server)).length).toBe(before);
    expect((await call(server, 'GET', '/api/server/backups', { cookie })).status).toBe(200);
  });
});
const clockNow = (): Date => systemClock.now();
