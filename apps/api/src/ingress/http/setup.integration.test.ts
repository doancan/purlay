/**
 * The setup in the browser over HTTP (D-179 §4, `API.md` §2 `/setup/*`): the real mounted application,
 * on a database of each test's own, its sign-in services held by the holder the composition root uses,
 * GitHub the strict stand-in on a loopback port reached through `GITHUB_URL` by the platform's own
 * `fetch`, and the relay a scripted one on this machine — so a step that saves really swaps what serves.
 *
 * What a caller without the claim can learn is held here too: one answer for closed, unclaimed, a
 * wrong cookie and a taken-over one, the same headers and about the same time; a limit per client on
 * every route, counted before anything is weighed; no secret, password, code or token in any line the
 * server writes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type Executor,
  DROP_HOOK_MS,
} from '@purlay/db';
import { SETUP_STEPS, type SetupState } from '@purlay/types';
import { createApp, type HttpApplication } from './app';
import { systemClock, type Clock } from '../../platform/clock';
import { SESSION_COOKIE, SETUP_COOKIE } from '../../platform/cookies';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { credentialCipher } from '../../platform/crypto';
import { NO_LOG } from '../../platform/events';
import { createLogger, type Logger } from '../../platform/logging';
import { deriveAuthSecret } from '../../modules/auth/better-auth';
import { inProcessEventBus } from '../../realtime/bus';
import type { RateBudget } from '../../realtime/rate-limiter';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aGitHubPerson, cookiesFrom } from '../../testing/github-sign-in';
import { aGitHubStub, GITHUB_STUB_CREDENTIALS, type GitHubStub } from '../../testing/github-stub';
import { aScriptedRelay, type ScriptedRelay } from '../../testing/smtp-relay';
import { aUserRow } from '../../testing/users';
import {
  readSettings,
  readSettingsToBoot,
  saveSettings,
  type SmtpSettings,
} from '../../modules/setup/settings';
import { issueSetupCode, SETUP_CODE_LINE, SETUP_TAKEOVER_IDLE_MS } from '../../modules/setup/setup';
import {
  runtimeServicesFrom,
  runtimeServicesHolder,
  type RuntimeHolder,
  type SettingsChange,
} from '../../modules/setup/runtime';
import { AUTH_BUDGET, SETUP_BUDGET, SETUP_SECRET_BUDGET } from './rate-limit';

const ORIGIN = 'https://purlay.test';
const cipher = credentialCipher(DEVELOPMENT_ENCRYPTION_KEY);
const ROOMY: RateBudget = { perSecond: 1000, burst: 100_000 };
const PASSWORD = 'analytical engine 1843';
const RELAY_USER = 'mailer';
const RELAY_PASS = 'relay-pass-7311';

const clones: (() => Promise<void>)[] = [];
const stops: (() => unknown)[] = [];
// Every wizard's database, dropped after its connections have closed (`dropDatabases`): one a test, forty-six
// of them, which fitted the five seconds a hook is given only on an idle machine (#797, D-228).
afterAll(async () => {
  for (const stop of stops) await stop();
  await Promise.all(
    clones.map(async (drop) => {
      await drop();
    }),
  );
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

/** A clock the test moves, from the wall clock: the setup code's hour is read from it. */
const movable = (): Clock & { advance: (ms: number) => void } => {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    advance: (ms): void => {
      offset += ms;
    },
  };
};

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

interface Wizard {
  readonly app: HttpApplication;
  readonly db: Executor;
  readonly holder: RuntimeHolder;
  readonly clock: ReturnType<typeof movable>;
  /** Every line the application and the services wrote. */
  readonly lines: string[];
  readonly github: GitHubStub;
  readonly person: ReturnType<typeof aGitHubPerson>;
  /** A start of the process: a new code, read from its own log, as the operator reads it. */
  readonly start: () => Promise<string>;
}

const aWizard = async (
  options: {
    readonly limits?: 'real' | 'roomy';
    readonly trustProxy?: boolean;
    /** A GitHub app in the settings from the start — as the environment seeds one — never tried. */
    readonly seededGitHub?: boolean;
    /** A relay in the settings from the start, never tried. */
    readonly seededRelay?: SmtpSettings;
  } = {},
): Promise<Wizard> => {
  const cloned = await cloneIntegrationDatabase();
  clones.push(cloned.drop);
  const person = aGitHubPerson();
  const github = aGitHubStub(person);
  const served = github.serve(0);
  stops.push(served.stop);
  const { log, lines } = recording();
  const clock = movable();
  const holder = runtimeServicesHolder(log);
  const build: SettingsChange['build'] = (settings, needsReentry) =>
    runtimeServicesFrom(
      settings,
      {
        database: cloned.db,
        baseUrl: ORIGIN,
        secret: deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY),
        log,
        githubUrls: { web: served.url, api: served.url },
        sessionTtlDays: 30,
        bus: inProcessEventBus(() => undefined, NO_LOG),
        clock,
      },
      needsReentry,
      holder.sends,
    );
  if (options.seededGitHub === true) {
    await saveSettings(cloned.db, cipher, systemClock, { github: GITHUB_STUB_CREDENTIALS });
  }
  if (options.seededRelay !== undefined) {
    await saveSettings(cloned.db, cipher, systemClock, { smtp: options.seededRelay });
  }
  const boot = await readSettingsToBoot(cloned.db, cipher);
  holder.settle(build(boot.settings, boot.needsReentry));
  const config = testConfig({
    APP_URL: ORIGIN,
    TRUST_PROXY: options.trustProxy ?? true,
    GITHUB_URL: served.url,
    GITHUB_API_URL: served.url,
  });
  const app = createApp(
    testDependencies({
      database: cloned.db,
      config,
      clock,
      log,
      auth: holder.auth,
      services: holder,
      settingsChange: { holder, cipher, clock, log, build },
      rateBudgets:
        options.limits === 'real'
          ? {
              auth: AUTH_BUDGET,
              writes: ROOMY,
              costlyReads: ROOMY,
              setup: SETUP_BUDGET,
              setupSecrets: SETUP_SECRET_BUDGET,
            }
          : { auth: ROOMY, writes: ROOMY, costlyReads: ROOMY, setup: ROOMY, setupSecrets: ROOMY },
    }),
  );
  const start = async (): Promise<string> => {
    const own = recording();
    await issueSetupCode(cloned.db, own.log, clock);
    const said = own.lines
      .map((line) => JSON.parse(line) as { msg?: string; setupCode?: unknown })
      .find((line) => line.msg === SETUP_CODE_LINE);
    if (typeof said?.setupCode !== 'string') throw new Error('the start wrote no setup code');
    return said.setupCode;
  };
  return { app, db: cloned.db, holder, clock, lines, github, person, start };
};

interface Call {
  readonly body?: unknown;
  readonly cookie?: string;
  readonly client?: string;
  readonly origin?: string;
}

const call = async (
  wizard: Wizard,
  method: 'GET' | 'HEAD' | 'POST',
  path: string,
  { body, cookie, client = '203.0.113.7', origin = ORIGIN }: Call = {},
): Promise<Response> =>
  await wizard.app.handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'POST' ? { origin } : {}),
        ...(cookie === undefined ? {} : { cookie }),
        'x-forwarded-for': client,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

/** The claim's cookie as the browser sends it back. */
const claimCookieOf = (response: Response): string => {
  const set = response.headers.getSetCookie().find((c) => c.startsWith(`${SETUP_COOKIE}=`));
  if (set === undefined) throw new Error('no claim cookie was set');
  return set.split(';')[0] ?? '';
};

const claimed = async (wizard: Wizard): Promise<string> => {
  const code = await wizard.start();
  const response = await call(wizard, 'POST', '/setup/claim', { body: { code } });
  expect(response.status).toBe(204);
  return claimCookieOf(response);
};

const stateOf = async (wizard: Wizard, cookie: string): Promise<SetupState> => {
  const response = await call(wizard, 'GET', '/setup/state', { cookie });
  expect(response.status).toBe(200);
  return (await response.json()) as SetupState;
};

const ADMIN = { name: 'Ada Lovelace', email: 'ada@example.test', password: PASSWORD };

/** A relay that takes the login above, on this machine. */
const aRelay = async (): Promise<ScriptedRelay> => {
  const relay = await aScriptedRelay({ login: { user: RELAY_USER, pass: RELAY_PASS } });
  stops.push(relay.stop);
  return relay;
};

const smtpOf = (relay: ScriptedRelay, pass = RELAY_PASS): string =>
  `smtp://${RELAY_USER}:${pass}@127.0.0.1:${String(relay.port)}`;

/** A message body as the mailbox shows it: quoted-printable's soft breaks and escapes undone. */
const quotedPrintable = (data: string): string =>
  data
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));

/** The same, read as UTF-8 text: what a person with an accented alphabet reads in the letter. */
const utf8Text = (data: string): string => {
  const joined = data.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let at = 0; at < joined.length; at += 1) {
    const hex = joined.slice(at + 1, at + 3);
    if (joined[at] === '=' && /^[0-9A-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      at += 2;
    } else bytes.push(...Buffer.from(joined.charAt(at), 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
};

const tokenIn = (relay: ScriptedRelay, at = 0): string => {
  const token = /\/setup\/verify#([0-9a-f]{64})/.exec(
    quotedPrintable(relay.received[at]?.data ?? ''),
  )?.[1];
  if (token === undefined) throw new Error('the letter carries no link');
  return token;
};

/** Through the steps to the one named, the way the wizard takes them: GitHub and mail skipped. */
const passedTo = async (
  wizard: Wizard,
  cookie: string,
  last: 'admin' | 'address' | 'policy' | 'github' | 'email' | 'workspace' | 'invite',
): Promise<void> => {
  const steps: [string, string, unknown][] = [
    ['admin', '/setup/admin', ADMIN],
    ['address', '/setup/address', { confirmed: true }],
    ['policy', '/setup/policy', { signUp: 'invite-only' }],
    ['github', '/setup/github', { skip: true }],
    ['email', '/setup/smtp', { skip: true }],
    ['workspace', '/setup/workspace', { name: 'Analytical', slug: 'analytical' }],
    ['invite', '/setup/invite', undefined],
  ];
  const passed: readonly string[] = (await stateOf(wizard, cookie)).steps;
  for (const [step, path, body] of steps) {
    if (passed.includes(step)) {
      if (step === last) return;
      continue;
    }
    const response = await call(wizard, 'POST', path, {
      cookie,
      ...(body === undefined ? {} : { body }),
    });
    expect([step, response.status]).toEqual([step, step === 'workspace' ? 201 : 200]);
    if (step === last) return;
  }
};

/** The routes only the claim's holder may use, each with a body it would accept. */
const HOLDER_ROUTES: readonly [method: 'GET' | 'POST', path: string, body: unknown][] = [
  ['GET', '/setup/state', undefined],
  ['POST', '/setup/address', { confirmed: true }],
  ['POST', '/setup/admin', ADMIN],
  ['POST', '/setup/policy', { signUp: 'open' }],
  ['POST', '/setup/github', { ...GITHUB_STUB_CREDENTIALS, save: true }],
  [
    'POST',
    '/setup/smtp',
    {
      smtpUrl: 'smtp://mailer:pw@127.0.0.1:1',
      from: 'purlay@example.test',
      allowPlaintext: false,
      locale: 'en',
      save: true,
    },
  ],
  ['POST', '/setup/smtp', { resend: true, locale: 'en' }],
  ['POST', '/setup/workspace', { name: 'Analytical', slug: 'analytical' }],
  ['POST', '/setup/invite', undefined],
  ['POST', '/setup/finish', undefined],
];

const UNAVAILABLE = {
  error: { code: 'SETUP_UNAVAILABLE', message: 'Setup is not available.' },
};

/** The headers a refusal is compared by: all but the ones that differ per request. */
const comparableHeaders = (response: Response): Record<string, string> =>
  Object.fromEntries([...response.headers.entries()].filter(([name]) => name !== 'x-request-id'));

describe('integration: the setup over HTTP, start to finish', () => {
  test('the whole setup: claim, administrator, address, policy, GitHub and mail tried and saved, workspace, finish', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();

    // Open, and nothing else said.
    const status = await call(wizard, 'GET', '/setup/status');
    expect([status.status, await status.json()]).toEqual([200, { open: true, appUrl: ORIGIN }]);

    const cookie = await claimed(wizard);
    expect((await stateOf(wizard, cookie)).steps).toEqual(['claim']);

    // The administrator: a weak password refused by its rule's name, then made and signed in.
    const weak = await call(wizard, 'POST', '/setup/admin', {
      cookie,
      body: { ...ADMIN, password: 'short' },
    });
    expect([weak.status, await weak.json()]).toEqual([
      400,
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Choose another password.',
          details: { fields: { password: 'too-short' } },
        },
      },
    ]);
    const admin = await call(wizard, 'POST', '/setup/admin', { cookie, body: ADMIN });
    expect(admin.status).toBe(200);
    const adminBody = await admin.text();
    expect(JSON.parse(adminBody)).toEqual({ signedIn: true });
    // The library's cookie and nothing of its body: the session's raw token never leaves the server.
    // The claim's cookie sent again, and the library's session cookie: nothing else.
    const names = admin.headers.getSetCookie().map((set) => set.split('=')[0]);
    expect(names).toEqual([SETUP_COOKIE, SESSION_COOKIE]);
    const session =
      cookiesFrom(admin)
        .split('; ')
        .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`)) ?? '';
    const token = session.split('=')[1]?.split('.')[0] ?? '';
    expect(token.length).toBeGreaterThan(16);
    expect(adminBody).not.toContain(token);

    const address = await call(wizard, 'POST', '/setup/address', {
      cookie,
      body: { confirmed: true },
    });
    expect(address.status).toBe(200);
    const policy = await call(wizard, 'POST', '/setup/policy', {
      cookie,
      body: { signUp: 'invite-only' },
    });
    expect(policy.status).toBe(200);

    // GitHub: tried, and saved because it worked — the instance serving now has the app.
    const tried = await call(wizard, 'POST', '/setup/github', {
      cookie,
      body: { ...GITHUB_STUB_CREDENTIALS, save: true },
    });
    expect([tried.status, await tried.json()]).toEqual([200, { ok: true }]);
    expect(wizard.github.refusals).toEqual(['bad_verification_code']);
    const methods = await call(wizard, 'GET', '/api/auth/methods');
    expect(await methods.json()).toEqual({
      github: true,
      email: false,
      oidc: null,
      signUp: 'invite-only',
    });
    const button = await call(wizard, 'GET', '/auth/github');
    expect(button.status).toBe(302);
    expect(new URL(button.headers.get('location') ?? '').searchParams.get('client_id')).toBe(
      GITHUB_STUB_CREDENTIALS.clientId,
    );

    // Mail: the relay is sent the administrator's letter, the try works, the relay is saved.
    const mailed = await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: {
        smtpUrl: smtpOf(relay),
        from: 'purlay@example.test',
        allowPlaintext: false,
        locale: 'en',
        save: true,
      },
    });
    expect([mailed.status, await mailed.json()]).toEqual([200, { ok: true }]);
    expect(relay.received.map((message) => message.to)).toEqual([[ADMIN.email]]);
    expect(await (await call(wizard, 'GET', '/api/auth/methods')).json()).toEqual({
      github: true,
      email: true,
      oidc: null,
      signUp: 'invite-only',
    });
    let state = await stateOf(wizard, cookie);
    expect(state.admin).toEqual({ name: ADMIN.name, email: ADMIN.email, emailVerified: false });
    expect(state.channels).toEqual({ github: true, email: true });
    expect(state.settings.smtp?.address).toEqual({
      set: true,
      host: `smtp://127.0.0.1:${String(relay.port)}`,
    });

    // The link in the letter, followed by a browser that holds nothing.
    const verified = await call(wizard, 'POST', '/setup/verify', {
      body: { token: tokenIn(relay) },
      client: '198.51.100.9',
    });
    expect([verified.status, await verified.json()]).toEqual([200, { verified: true }]);

    const made = await call(wizard, 'POST', '/setup/workspace', {
      cookie,
      body: { name: 'Analytical', slug: 'analytical' },
    });
    expect(made.status).toBe(201);
    const workspace = (await made.json()) as { id: string; slug: string };
    expect(workspace.slug).toBe('analytical');
    const owner = await wizard.db
      .selectFrom('workspace_members')
      .innerJoin('users', 'users.id', 'workspace_members.user_id')
      .select(['users.email', 'workspace_members.role'])
      .where('workspace_members.workspace_id', '=', workspace.id)
      .execute();
    expect(owner).toEqual([{ email: ADMIN.email, role: 'owner' }]);
    const channels = await wizard.db
      .selectFrom('channels')
      .select('name')
      .where('workspace_id', '=', workspace.id)
      .execute();
    expect(channels.map(({ name }) => name)).toEqual(['general']);

    // The finish is refused until the invitations are passed (skipped here).
    const early = await call(wizard, 'POST', '/setup/finish', { cookie });
    expect([early.status, await early.json()]).toEqual([
      409,
      {
        error: {
          code: 'SETUP_STEP_REFUSED',
          message: 'Setup cannot be finished yet.',
          details: { reason: 'out-of-order' },
        },
      },
    ]);
    expect((await call(wizard, 'POST', '/setup/invite', { cookie })).status).toBe(200);
    state = await stateOf(wizard, cookie);
    expect(state).toMatchObject({
      steps: SETUP_STEPS.slice(0, -1),
      appUrl: ORIGIN,
      githubCallbackUrl: `${ORIGIN}/auth/callback/github`,
      needsReentry: [],
      admin: { name: ADMIN.name, email: ADMIN.email, emailVerified: true },
      workspace: { id: workspace.id, name: 'Analytical', slug: 'analytical' },
      canFinish: true,
      finishProblems: [],
    });
    // The address check is the status's (public, before the claim): nothing of it here.
    expect('addressMatches' in state).toBe(false);
    expect(state.settings.github).toEqual({
      clientId: GITHUB_STUB_CREDENTIALS.clientId,
      clientSecret: { set: true },
    });

    const finished = await call(wizard, 'POST', '/setup/finish', { cookie });
    expect(finished.status).toBe(204);
    expect(finished.headers.getSetCookie()).toEqual([
      `${SETUP_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
    ]);

    // Closed: the status says so, and the holder's own cookie opens nothing any more.
    expect(await (await call(wizard, 'GET', '/setup/status')).json()).toEqual({
      open: false,
      appUrl: ORIGIN,
    });
    const after = await call(wizard, 'GET', '/setup/state', { cookie });
    expect([after.status, await after.json()]).toEqual([404, UNAVAILABLE]);
    // The administrator's session, made by the setup, is a session.
    const me = await call(wizard, 'GET', '/api/me', { cookie: session });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ user: { email: ADMIN.email } });
  });

  test('nothing secret is in any line the server writes, the whole way through', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const code = await wizard.start();
    const claim = await call(wizard, 'POST', '/setup/claim', { body: { code } });
    const cookie = claimCookieOf(claim);
    await passedTo(wizard, cookie, 'policy');
    await call(wizard, 'POST', '/setup/github', {
      cookie,
      body: { ...GITHUB_STUB_CREDENTIALS, clientSecret: 'a-wrong-secret-4410' },
    });
    await call(wizard, 'POST', '/setup/github', {
      cookie,
      body: { ...GITHUB_STUB_CREDENTIALS, save: true },
    });
    await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: {
        smtpUrl: smtpOf(relay, 'a-wrong-relay-pass-55'),
        from: 'purlay@example.test',
        allowPlaintext: false,
        locale: 'en',
      },
    });
    await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: {
        smtpUrl: smtpOf(relay),
        from: 'purlay@example.test',
        allowPlaintext: false,
        locale: 'en',
        save: true,
      },
    });
    // A letter again, taken; then again, with the relay gone: what the new path writes holds no secret either.
    await call(wizard, 'POST', '/setup/smtp', { cookie, body: { resend: true, locale: 'en' } });
    const first = tokenIn(relay, 0);
    const verification = tokenIn(relay, 1);
    await relay.stop();
    const gone = await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: { resend: true, locale: 'en' },
    });
    expect(await gone.json()).toMatchObject({ ok: false, reason: 'unreachable' });
    await call(wizard, 'POST', '/setup/verify', { body: { token: verification } });
    await call(wizard, 'POST', '/setup/verify', { body: { token: 'f'.repeat(64) } });
    await passedTo(wizard, cookie, 'invite');
    await call(wizard, 'POST', '/setup/finish', { cookie });

    const written = wizard.lines.join('\n');
    expect(wizard.lines.length).toBeGreaterThan(10);
    for (const secret of [
      code,
      code.replaceAll('-', ''),
      cookie.split('=')[1] ?? '',
      PASSWORD,
      GITHUB_STUB_CREDENTIALS.clientSecret,
      'a-wrong-secret-4410',
      RELAY_PASS,
      'a-wrong-relay-pass-55',
      first,
      verification,
    ]) {
      expect([secret, written.includes(secret)]).toEqual([secret, false]);
    }
  });
});

describe('integration: the claim', () => {
  test('sets a __Host- cookie for the claim’s idle day, Strict, and answers nothing else', async () => {
    const wizard = await aWizard();
    const code = await wizard.start();
    const response = await call(wizard, 'POST', '/setup/claim', { body: { code } });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    const [set, ...others] = response.headers.getSetCookie();
    expect(others).toEqual([]);
    expect(set).toMatch(
      new RegExp(
        `^${SETUP_COOKIE}=[0-9a-f]{64}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400$`,
      ),
    );
  });

  test('a wrong code is a field’s refusal; the fifth locks setup, said with Retry-After', async () => {
    const wizard = await aWizard();
    await wizard.start();
    for (let n = 1; n <= 4; n += 1) {
      const wrong = await call(wizard, 'POST', '/setup/claim', { body: { code: 'WRONG-CODE' } });
      expect([wrong.status, await wrong.json()]).toEqual([
        400,
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'That is not the setup code.',
            details: { fields: { code: 'is not the setup code' } },
          },
        },
      ]);
    }
    const fifth = await call(wizard, 'POST', '/setup/claim', { body: { code: 'WRONG-CODE' } });
    expect(fifth.status).toBe(429);
    expect(await fifth.json()).toEqual({
      error: {
        code: 'SETUP_LOCKED',
        message:
          'Too many wrong setup codes. Wait, then try again; a restart of the server ends the wait.',
      },
    });
    expect(Number(fifth.headers.get('retry-after'))).toBe(15 * 60);
    wizard.clock.advance(60_000);
    const locked = await call(wizard, 'POST', '/setup/claim', { body: { code: 'WRONG-CODE' } });
    expect([locked.status, Number(locked.headers.get('retry-after'))]).toEqual([429, 14 * 60]);
  });

  test('a second browser is told setup is unavailable, as on a closed server; the code is spent', async () => {
    const wizard = await aWizard();
    const code = await wizard.start();
    expect((await call(wizard, 'POST', '/setup/claim', { body: { code } })).status).toBe(204);
    const second = await call(wizard, 'POST', '/setup/claim', {
      body: { code },
      client: '198.51.100.20',
    });
    expect([second.status, await second.json()]).toEqual([404, UNAVAILABLE]);
  });

  test('a cross-site claim is refused at the edge, before the code is weighed or counted', async () => {
    const wizard = await aWizard();
    const code = await wizard.start();
    const response = await call(wizard, 'POST', '/setup/claim', {
      body: { code },
      origin: 'https://evil.example',
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('FORBIDDEN');
    const row = await wizard.db
      .selectFrom('setup_state')
      .select(['failed_attempts', 'claim_digest'])
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ failed_attempts: 0, claim_digest: null });
  });
});

describe('integration: only the browser holding the claim', () => {
  test('every holder route refuses no cookie, a wrong one and a taken-over one alike, and no probe is called', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const old = await claimed(wizard);
    // Taken over: idle fifteen minutes, then a later start's code claims it.
    wizard.clock.advance(SETUP_TAKEOVER_IDLE_MS);
    const code = await wizard.start();
    const taken = await call(wizard, 'POST', '/setup/claim', { body: { code } });
    expect(taken.status).toBe(204);
    const routes = HOLDER_ROUTES.map(([method, path, body]): [typeof method, string, unknown] => [
      method,
      path,
      path === '/setup/smtp' && typeof body === 'object' && body !== null && 'from' in body
        ? { ...body, smtpUrl: smtpOf(relay) }
        : body,
    ]);
    for (const cookie of [undefined, `${SETUP_COOKIE}=${'a'.repeat(64)}`, old]) {
      for (const [method, path, body] of routes) {
        const response = await call(wizard, method, path, {
          ...(cookie === undefined ? {} : { cookie }),
          ...(body === undefined ? {} : { body }),
        });
        expect([path, response.status, await response.json()]).toEqual([path, 404, UNAVAILABLE]);
        expect(response.headers.getSetCookie()).toEqual([]);
        if (method === 'POST') {
          // The guard before the body: a stranger is not told what a step would take.
          const malformed = await call(wizard, method, path, {
            ...(cookie === undefined ? {} : { cookie }),
            body: { bogus: true },
          });
          expect([path, malformed.status]).toEqual([path, 404]);
        }
      }
    }
    expect(wizard.github.presentedCodes).toEqual([]);
    expect(relay.commands).toEqual([]);
    expect(await readSettings(wizard.db, cipher)).toMatchObject({
      github: undefined,
      smtp: undefined,
      signUp: 'invite-only',
    });
  });

  test('closed, unclaimed, a wrong cookie and a taken-over one: the same answer, the same headers, about the same time', async () => {
    const unclaimed = await aWizard();
    const holding = await aWizard();
    const finished = await aWizard();
    const holder = await claimed(holding);
    const done = await claimed(finished);
    await saveSettings(finished.db, cipher, systemClock, { github: GITHUB_STUB_CREDENTIALS });
    await passedTo(finished, done, 'policy');
    const github = await call(finished, 'POST', '/setup/github', {
      cookie: done,
      body: { ...GITHUB_STUB_CREDENTIALS, save: true },
    });
    expect(github.status).toBe(200);
    await call(finished, 'POST', '/setup/smtp', { cookie: done, body: { skip: true } });
    await passedTo(finished, done, 'invite');
    expect((await call(finished, 'POST', '/setup/finish', { cookie: done })).status).toBe(204);
    expect(holder).not.toBe(done);

    const askers: [string, () => Promise<Response>][] = [
      ['unclaimed', async (): Promise<Response> => await call(unclaimed, 'GET', '/setup/state')],
      [
        'wrong cookie',
        async (): Promise<Response> =>
          await call(holding, 'GET', '/setup/state', {
            cookie: `${SETUP_COOKIE}=${'b'.repeat(64)}`,
          }),
      ],
      [
        'closed',
        async (): Promise<Response> =>
          await call(finished, 'GET', '/setup/state', { cookie: done }),
      ],
    ];
    const first = await askers[0]?.[1]();
    if (first === undefined) throw new Error('no first answer');
    const firstBody = await first.text();
    for (const [, ask] of askers) {
      const answered = await ask();
      expect(answered.status).toBe(404);
      expect(await answered.text()).toBe(firstBody);
      expect(comparableHeaders(answered)).toEqual(comparableHeaders(first));
    }

    const SAMPLES = 40;
    const times = new Map<string, number[]>(askers.map(([name]) => [name, []]));
    for (let n = 0; n < SAMPLES; n += 1) {
      for (const [name, ask] of askers) {
        const started = performance.now();
        await ask();
        times.get(name)?.push(performance.now() - started);
      }
    }
    const median = (values: readonly number[]): number =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
    const medians = [...times.entries()].map(([name, values]) => [name, median(values)] as const);
    console.info(
      `setup refusal timing, ${String(SAMPLES)} samples each: ${medians.map(([name, ms]) => `${name} ${ms.toFixed(2)} ms`).join(', ')}`,
    );
    const values = medians.map(([, ms]) => ms);
    expect(Math.max(...values) / Math.min(...values)).toBeLessThan(2);
  });

  test('a relay out of turn is neither tried nor saved', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'admin');
    const response = await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: {
        smtpUrl: smtpOf(relay),
        from: 'purlay@example.test',
        allowPlaintext: false,
        locale: 'en',
        save: true,
      },
    });
    expect(response.status).toBe(409);
    expect(relay.commands).toEqual([]);
    expect((await readSettings(wizard.db, cipher)).smtp).toBeUndefined();
  });

  test('every pass of the guard sends the claim’s cookie again, for the claim’s idle day', async () => {
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    const read = await call(wizard, 'GET', '/setup/state', { cookie });
    expect(read.headers.getSetCookie()).toEqual([
      `${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
    ]);
    const step = await call(wizard, 'POST', '/setup/admin', { cookie, body: ADMIN });
    expect(step.headers.getSetCookie()).toContain(
      `${cookie}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
    );
  });

  test('a step before its turn is refused, and nothing is tried or saved', async () => {
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'admin');
    const github = await call(wizard, 'POST', '/setup/github', {
      cookie,
      body: { ...GITHUB_STUB_CREDENTIALS, save: true },
    });
    expect([github.status, await github.json()]).toEqual([
      409,
      {
        error: {
          code: 'SETUP_STEP_REFUSED',
          message: 'That step comes later.',
          details: { reason: 'out-of-order' },
        },
      },
    ]);
    expect(wizard.github.presentedCodes).toEqual([]);
    const policy = await call(wizard, 'POST', '/setup/policy', {
      cookie,
      body: { signUp: 'open' },
    });
    expect(policy.status).toBe(409);
    expect((await readSettings(wizard.db, cipher)).signUp).toBe('invite-only');
  });

  test('a second administrator is refused; an address an account has is a conflict', async () => {
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'admin');
    const again = await call(wizard, 'POST', '/setup/admin', {
      cookie,
      body: { ...ADMIN, email: 'other@example.test' },
    });
    expect([again.status, await again.json()]).toEqual([
      409,
      {
        error: {
          code: 'SETUP_STEP_REFUSED',
          message: 'This setup has its administrator already.',
          details: { reason: 'admin-exists' },
        },
      },
    ]);
  });

  test('the administrator’s fields are refused by name, the password by its rule', async () => {
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    const cases: [Record<string, string>, Record<string, string>][] = [
      [{ email: 'not an address' }, { email: 'is not an email address' }],
      [{ name: '   ' }, { name: 'is one to 128 characters' }],
      [{ password: 'ada@example.test 1234' }, { password: 'contains-email' }],
      [{ password: 'Password123!' }, { password: 'common' }],
    ];
    for (const [change, fields] of cases) {
      const response = await call(wizard, 'POST', '/setup/admin', {
        cookie,
        body: { ...ADMIN, ...change },
      });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { details: unknown } }).error.details).toEqual({
        fields,
      });
    }
    expect((await stateOf(wizard, cookie)).admin).toBeNull();
  });
});

describe('integration: a try that fails saves nothing', () => {
  test('GitHub: a wrong secret and an unknown app, each its reason and GitHub’s words; the old settings serve', async () => {
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'policy');
    const before = wizard.holder.current();
    const wrong = await call(wizard, 'POST', '/setup/github', {
      cookie,
      body: { ...GITHUB_STUB_CREDENTIALS, clientSecret: 'not-the-secret', save: true },
    });
    expect([wrong.status, await wrong.json()]).toEqual([
      200,
      { ok: false, reason: 'secret-rejected', raw: 'incorrect_client_credentials' },
    ]);
    const unknown = await call(wizard, 'POST', '/setup/github', {
      cookie,
      body: { clientId: 'no-such-app', clientSecret: 'whatever', save: true },
    });
    expect([unknown.status, await unknown.json()]).toEqual([
      200,
      { ok: false, reason: 'client-unknown', raw: '404 Not Found' },
    ]);
    expect(wizard.holder.current()).toBe(before);
    expect((await readSettings(wizard.db, cipher)).github).toBeUndefined();
    const state = await stateOf(wizard, cookie);
    expect(state.steps).toEqual(['claim', 'admin', 'address', 'policy']);
    expect(state.channels).toEqual({ github: false, email: false });
    expect((await call(wizard, 'GET', '/auth/github')).status).toBe(404);
  });

  test('a try that works but is not to be kept saves nothing and passes no step', async () => {
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'policy');
    const tried = await call(wizard, 'POST', '/setup/github', {
      cookie,
      body: GITHUB_STUB_CREDENTIALS,
    });
    expect(await tried.json()).toEqual({ ok: true });
    expect((await readSettings(wizard.db, cipher)).github).toBeUndefined();
    expect((await stateOf(wizard, cookie)).steps).not.toContain('github');
  });

  test('mail: a refused login is `auth-failed`, the password nowhere in the reply; nothing saved', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'github');
    const before = wizard.holder.current();
    const response = await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: {
        smtpUrl: smtpOf(relay, 'the-wrong-password-9'),
        from: 'purlay@example.test',
        allowPlaintext: false,
        locale: 'en',
        save: true,
      },
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { ok: boolean; reason: string; raw: string };
    expect([result.ok, result.reason]).toEqual([false, 'auth-failed']);
    expect(result.raw).not.toContain('the-wrong-password-9');
    expect(relay.received).toEqual([]);
    expect(wizard.holder.current()).toBe(before);
    expect((await readSettings(wizard.db, cipher)).smtp).toBeUndefined();
    expect((await stateOf(wizard, cookie)).channels.email).toBe(false);
  });

  test('a relay address or sender that cannot be tried is a field’s refusal, before any letter is made', async () => {
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'github');
    const cases: [Record<string, unknown>, string][] = [
      [{ smtpUrl: 'http://relay.example' }, 'smtpUrl'],
      [{ smtpUrl: 'smtp://relay.example\n:25' }, 'smtpUrl'],
      [{ from: 'Ada <ada@example.test>' }, 'from'],
    ];
    for (const [change, field] of cases) {
      const response = await call(wizard, 'POST', '/setup/smtp', {
        cookie,
        body: {
          smtpUrl: 'smtp://relay.example',
          from: 'purlay@example.test',
          allowPlaintext: false,
          locale: 'en',
          ...change,
        },
      });
      expect(response.status).toBe(400);
      const { error } = (await response.json()) as { error: { details: { fields: object } } };
      expect(Object.keys(error.details.fields)).toEqual([field]);
    }
    const pending = await wizard.db
      .selectFrom('admin_email_verification')
      .select('user_id')
      .where('id', '=', true)
      .execute();
    expect(pending).toEqual([]);
  });

  test('an address already verified is sent a plain test letter, with no link', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'github');
    await wizard.db
      .updateTable('users')
      .set({ email_verified: true })
      .where('email', '=', ADMIN.email)
      .execute();
    const response = await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: {
        smtpUrl: smtpOf(relay),
        from: 'purlay@example.test',
        allowPlaintext: false,
        locale: 'en',
        save: true,
      },
    });
    expect(await response.json()).toEqual({ ok: true });
    const data = quotedPrintable(relay.received[0]?.data ?? '');
    expect(data).toContain('Subject: A test from your Purlay server');
    expect(data).not.toContain('/setup/verify');
    expect((await stateOf(wizard, cookie)).channels.email).toBe(true);
  });

  test('a change refused while the server shuts down is said as busy, and nothing is saved', async () => {
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'address');
    wizard.holder.refuseChanges();
    const response = await call(wizard, 'POST', '/setup/policy', {
      cookie,
      body: { signUp: 'open' },
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'DATABASE_UNAVAILABLE',
    );
    expect((await readSettings(wizard.db, cipher)).signUp).toBe('invite-only');
    expect((await stateOf(wizard, cookie)).steps).not.toContain('policy');
  });
});

describe('integration: the letter again (D-179 §4.3)', () => {
  const RESEND = { resend: true, locale: 'en' } as const;

  /** Through GitHub skipped, then the relay kept, with the first letter in its mailbox. */
  const kept = async (wizard: Wizard, cookie: string, relay: ScriptedRelay): Promise<void> => {
    await passedTo(wizard, cookie, 'github');
    const response = await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: {
        smtpUrl: smtpOf(relay),
        from: 'purlay@example.test',
        allowPlaintext: false,
        locale: 'en',
        save: true,
      },
    });
    expect(await response.json()).toEqual({ ok: true });
  };

  test('sends another letter through the relay that was kept: a new link, the old one no longer opens, nothing is saved again', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await kept(wizard, cookie, relay);
    const before = await readSettings(wizard.db, cipher);
    const response = await call(wizard, 'POST', '/setup/smtp', { cookie, body: RESEND });
    expect([response.status, await response.json()]).toEqual([200, { ok: true }]);
    expect(relay.received).toHaveLength(2);
    expect(relay.received[1]?.to).toEqual([ADMIN.email]);
    const first = tokenIn(relay, 0);
    const second = tokenIn(relay, 1);
    expect(second).not.toBe(first);
    expect((await call(wizard, 'POST', '/setup/verify', { body: { token: first } })).status).toBe(
      404,
    );
    expect((await call(wizard, 'POST', '/setup/verify', { body: { token: second } })).status).toBe(
      200,
    );
    expect(await readSettings(wizard.db, cipher)).toEqual(before);
  });

  test('is refused before the mail step, and while no relay is kept, and sends nothing', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'policy');
    for (const stage of ['before the mail step', 'with the mail step skipped']) {
      if (stage === 'with the mail step skipped') await passedTo(wizard, cookie, 'email');
      const response = await call(wizard, 'POST', '/setup/smtp', { cookie, body: RESEND });
      expect([stage, response.status, await response.json()]).toEqual([
        stage,
        409,
        {
          error: {
            code: 'SETUP_STEP_REFUSED',
            message: 'That step comes later.',
            details: { reason: 'out-of-order' },
          },
        },
      ]);
    }
    expect(relay.commands).toEqual([]);
  });

  test('is refused before the mail step even when the settings already hold a relay, and sends nothing', async () => {
    const relay = await aRelay();
    const wizard = await aWizard({
      seededRelay: { smtpUrl: smtpOf(relay), from: 'purlay@example.test', allowPlaintext: false },
    });
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'policy');
    const response = await call(wizard, 'POST', '/setup/smtp', { cookie, body: RESEND });
    expect(response.status).toBe(409);
    expect(relay.commands).toEqual([]);
    const pending = await wizard.db
      .selectFrom('admin_email_verification')
      .select('user_id')
      .where('id', '=', true)
      .execute();
    expect(pending).toEqual([]);
  });

  test('a relay that fails now is said by its reason, and the link the last letter carried still opens', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await kept(wizard, cookie, relay);
    const first = tokenIn(relay, 0);
    await relay.stop();
    const response = await call(wizard, 'POST', '/setup/smtp', { cookie, body: RESEND });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: false, reason: 'unreachable' });
    expect((await call(wizard, 'POST', '/setup/verify', { body: { token: first } })).status).toBe(
      200,
    );
  });

  test('a new relay tried and refused leaves the link the first letter carried opening', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await kept(wizard, cookie, relay);
    const first = tokenIn(relay, 0);
    const tried = await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: {
        smtpUrl: smtpOf(relay, 'the-wrong-password-9'),
        from: 'purlay@example.test',
        allowPlaintext: false,
        locale: 'en',
        save: true,
      },
    });
    expect(await tried.json()).toMatchObject({ ok: false, reason: 'auth-failed' });
    expect((await call(wizard, 'POST', '/setup/verify', { body: { token: first } })).status).toBe(
      200,
    );
  });

  test('a kept relay whose sender no longer passes the rules is a refusal by field, and the link still opens', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await kept(wizard, cookie, relay);
    const first = tokenIn(relay, 0);
    await wizard.db
      .updateTable('server_settings')
      .set({ mail_from: 'Purlay <purlay@example.test>' })
      .execute();
    const response = await call(wizard, 'POST', '/setup/smtp', { cookie, body: RESEND });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: { details: { fields: object } } };
    expect(Object.keys(error.details.fields)).toEqual(['from']);
    expect(relay.received).toHaveLength(1);
    expect((await call(wizard, 'POST', '/setup/verify', { body: { token: first } })).status).toBe(
      200,
    );
  });

  test('an address already verified is sent the plain test letter, with no link', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await kept(wizard, cookie, relay);
    await wizard.db
      .updateTable('users')
      .set({ email_verified: true })
      .where('email', '=', ADMIN.email)
      .execute();
    const response = await call(wizard, 'POST', '/setup/smtp', { cookie, body: RESEND });
    expect(await response.json()).toEqual({ ok: true });
    const data = quotedPrintable(relay.received[1]?.data ?? '');
    expect(data).toContain('Subject: A test from your Purlay server');
    expect(data).not.toContain('/setup/verify');
  });

  test('writes the letter in the language asked for', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await kept(wizard, cookie, relay);
    const response = await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: { resend: true, locale: 'tr' },
    });
    expect(await response.json()).toEqual({ ok: true });
    const turkish = utf8Text(relay.received[1]?.data ?? '');
    expect(turkish).toContain('Bir Purlay sunucusu kurmuyorsan');
    expect(utf8Text(relay.received[0]?.data ?? '')).toContain('If you are not setting up');
    // And the link in it is the one that opens.
    const link = /\/setup\/verify#([0-9a-f]{64})/.exec(turkish)?.[1] ?? '';
    expect((await call(wizard, 'POST', '/setup/verify', { body: { token: link } })).status).toBe(
      200,
    );
  });

  test('passes no step and counts for no channel: a relay only in the settings is still untried after it', async () => {
    const relay = await aRelay();
    const wizard = await aWizard({
      seededRelay: { smtpUrl: smtpOf(relay), from: 'purlay@example.test', allowPlaintext: false },
    });
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'github');
    const before = await stateOf(wizard, cookie);
    const response = await call(wizard, 'POST', '/setup/smtp', { cookie, body: RESEND });
    expect(await response.json()).toEqual({ ok: true });
    expect(relay.received).toHaveLength(1);
    const after = await stateOf(wizard, cookie);
    expect(after.steps).toEqual(before.steps);
    expect(after.steps).not.toContain('email');
    expect(after.channels.email).toBe(false);
  });

  test('a relay whose login the key can no longer open is no relay: refused as out of turn, nothing sent', async () => {
    const relay = await aRelay();
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'github');
    // Sealed under another key, as after a rotation.
    const rotated = credentialCipher(
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    );
    await saveSettings(wizard.db, rotated, systemClock, {
      smtp: { smtpUrl: smtpOf(relay), from: 'purlay@example.test', allowPlaintext: false },
    });
    const response = await call(wizard, 'POST', '/setup/smtp', { cookie, body: RESEND });
    expect(response.status).toBe(409);
    expect(relay.commands).toEqual([]);
  });

  test('every resend is counted with the holder routes: the thirty-first in the window is limited, and no letter more is sent', async () => {
    const wizard = await aWizard({ limits: 'real' });
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await kept(wizard, cookie, relay);
    let sent = 0;
    let limited: Response | undefined;
    for (let n = 0; n < SETUP_BUDGET.burst + 5 && limited === undefined; n += 1) {
      const response = await call(wizard, 'POST', '/setup/smtp', { cookie, body: RESEND });
      if (response.status === 429) limited = response;
      else {
        expect(response.status).toBe(200);
        sent += 1;
      }
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(sent).toBeLessThanOrEqual(SETUP_BUDGET.burst);
    // The first letter, and one for each resend that was let through: none for the one that was not.
    expect(relay.received).toHaveLength(1 + sent);
  });

  test('a body that is neither a try, a skip nor a resend is a refusal by name, and nothing is sent', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await kept(wizard, cookie, relay);
    for (const body of [
      { resend: true },
      { resend: false, locale: 'en' },
      { resend: true, locale: 'de' },
      { resend: true, locale: 'en', smtpUrl: smtpOf(relay) },
    ]) {
      const response = await call(wizard, 'POST', '/setup/smtp', { cookie, body });
      expect([JSON.stringify(body), response.status]).toEqual([JSON.stringify(body), 400]);
    }
    expect(relay.received).toHaveLength(1);
  });
});

describe('integration: the finish rule', () => {
  test('refused while no way for other people to sign in is connected and tried; a GitHub app only in the settings does not count', async () => {
    // Seeded and serving, never tried: the setup does not count it.
    const wizard = await aWizard({ seededGitHub: true });
    expect(await (await call(wizard, 'GET', '/api/auth/methods')).json()).toEqual({
      github: true,
      email: false,
      oidc: null,
      signUp: 'invite-only',
    });
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'invite');
    const refused = await call(wizard, 'POST', '/setup/finish', { cookie });
    expect([refused.status, await refused.json()]).toEqual([
      409,
      {
        error: {
          code: 'SETUP_STEP_REFUSED',
          message: 'Setup cannot be finished yet.',
          details: { reason: 'no-channel' },
        },
      },
    ]);
    const state = await stateOf(wizard, cookie);
    expect([state.canFinish, state.finishProblems]).toEqual([false, ['no-channel']]);
    expect(state.settings.github?.clientSecret).toEqual({ set: true });
    expect(state.channels).toEqual({ github: false, email: false });
    expect(await (await call(wizard, 'GET', '/setup/status')).json()).toEqual({
      open: true,
      appUrl: ORIGIN,
    });

    // Tried and saved now, from the step it belongs to — passed again, which changes nothing else.
    const github = await call(wizard, 'POST', '/setup/github', {
      cookie,
      body: { ...GITHUB_STUB_CREDENTIALS, save: true },
    });
    expect(await github.json()).toEqual({ ok: true });
    expect((await stateOf(wizard, cookie)).canFinish).toBe(true);
    expect((await call(wizard, 'POST', '/setup/finish', { cookie })).status).toBe(204);
  });

  test('a relay only in the settings does not count either', async () => {
    const relay = await aRelay();
    const wizard = await aWizard({
      seededRelay: { smtpUrl: smtpOf(relay), from: 'purlay@example.test', allowPlaintext: false },
    });
    expect(await (await call(wizard, 'GET', '/api/auth/methods')).json()).toEqual({
      github: false,
      email: true,
      oidc: null,
      signUp: 'invite-only',
    });
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'invite');
    const refused = await call(wizard, 'POST', '/setup/finish', { cookie });
    expect(refused.status).toBe(409);
    expect(
      ((await refused.json()) as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe('no-channel');
    expect((await stateOf(wizard, cookie)).channels).toEqual({ github: false, email: false });
  });

  test('refused when the first workspace is gone', async () => {
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'policy');
    await call(wizard, 'POST', '/setup/github', {
      cookie,
      body: { ...GITHUB_STUB_CREDENTIALS, save: true },
    });
    await passedTo(wizard, cookie, 'invite');
    await wizard.db
      .updateTable('workspaces')
      .set({ deleted_at: new Date() })
      .where('slug', '=', 'analytical')
      .execute();
    const refused = await call(wizard, 'POST', '/setup/finish', { cookie });
    expect([refused.status, await refused.json()]).toEqual([
      409,
      {
        error: {
          code: 'SETUP_STEP_REFUSED',
          message: 'Setup cannot be finished yet.',
          details: { reason: 'no-workspace' },
        },
      },
    ]);
    expect((await stateOf(wizard, cookie)).finishProblems).toEqual(['no-workspace']);
  });

  test('the first workspace is made once: asked again, the one made is the answer', async () => {
    const wizard = await aWizard();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'workspace');
    const again = await call(wizard, 'POST', '/setup/workspace', {
      cookie,
      body: { name: 'Another', slug: 'another' },
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ name: 'Analytical', slug: 'analytical' });
    const made = await wizard.db
      .selectFrom('workspaces')
      .select('slug')
      .where('slug', 'in', ['analytical', 'another'])
      .execute();
    expect(made).toEqual([{ slug: 'analytical' }]);
  });
});

describe('integration: after the finish', () => {
  test('every route but the status and the address link is the closed answer', async () => {
    const wizard = await aWizard();
    const relay = await aRelay();
    const cookie = await claimed(wizard);
    await passedTo(wizard, cookie, 'github');
    await call(wizard, 'POST', '/setup/smtp', {
      cookie,
      body: {
        smtpUrl: smtpOf(relay),
        from: 'purlay@example.test',
        allowPlaintext: false,
        locale: 'en',
        save: true,
      },
    });
    await passedTo(wizard, cookie, 'invite');
    expect((await call(wizard, 'POST', '/setup/finish', { cookie })).status).toBe(204);

    for (const [method, path, body] of [
      ...HOLDER_ROUTES,
      ['POST', '/setup/claim', { code: await wizard.start().catch(() => 'AAAA-BBBB') }] as const,
    ]) {
      const response = await call(wizard, method, path, {
        cookie,
        ...(body === undefined ? {} : { body }),
      });
      expect([path, response.status, await response.json()]).toEqual([path, 404, UNAVAILABLE]);
    }
    // The letter's link still opens, for its day, in a browser that never held anything.
    const verified = await call(wizard, 'POST', '/setup/verify', {
      body: { token: tokenIn(relay) },
    });
    expect([verified.status, await verified.json()]).toEqual([200, { verified: true }]);
  });

  test('a malformed link is refused before the database is asked: a held row does not hold it up', async () => {
    const wizard = await aWizard();
    const user = await aUserRow(wizard.db, 'held');
    await wizard.db
      .insertInto('admin_email_verification')
      .values({
        id: true,
        user_id: user.userId,
        email: user.email,
        token_digest: 'a'.repeat(64),
        issued_at: new Date(),
      })
      .execute();
    const outcome = await wizard.db.transaction().execute(async (transaction) => {
      // The row every weighing of a link locks first.
      await transaction
        .selectFrom('admin_email_verification')
        .select('id')
        .where('id', '=', true)
        .forUpdate()
        .execute();
      const answered = call(wizard, 'POST', '/setup/verify', { body: { token: 'g'.repeat(5000) } });
      const waited = new Promise<'held'>((resolve) => {
        setTimeout(() => {
          resolve('held');
        }, 1_000);
      });
      const first = await Promise.race([answered.then((response) => response.status), waited]);
      return first;
    });
    expect(outcome).toBe(404);
  });

  test('a link that does not open is one answer, malformed or not', async () => {
    const wizard = await aWizard();
    const answers = await Promise.all(
      [{ token: 'f'.repeat(64) }, { token: 'short' }, { token: 'g'.repeat(5000) }, {}, 'text'].map(
        async (body) => {
          const response = await call(wizard, 'POST', '/setup/verify', { body });
          return [response.status, await response.json()];
        },
      ),
    );
    for (const answer of answers) {
      expect(answer).toEqual([
        404,
        { error: { code: 'ADMIN_LINK_NOT_FOUND', message: 'This link does not open.' } },
      ]);
    }
  });
});

describe('integration: the edge around /setup', () => {
  test('the status is one shape for everybody, open or not, claimed or not', async () => {
    const wizard = await aWizard();
    const fresh = await call(wizard, 'GET', '/setup/status');
    expect(await fresh.json()).toEqual({ open: true, appUrl: ORIGIN });
    const cookie = await claimed(wizard);
    for (const asked of [
      await call(wizard, 'GET', '/setup/status'),
      await call(wizard, 'GET', '/setup/status', { cookie }),
    ]) {
      expect(await asked.json()).toEqual({ open: true, appUrl: ORIGIN });
    }
  });

  test('every /setup answer is never stored and never indexed, refusals and limits included', async () => {
    const wizard = await aWizard({ limits: 'real' });
    const answers = [
      await call(wizard, 'GET', '/setup/status'),
      await call(wizard, 'GET', '/setup/state'),
      await call(wizard, 'POST', '/setup/claim', { body: { code: 'nope' } }),
      await call(wizard, 'POST', '/setup/verify', { body: { token: 'nope' } }),
    ];
    for (let n = 0; n < SETUP_SECRET_BUDGET.burst; n += 1) {
      answers.push(await call(wizard, 'POST', '/setup/verify', { body: {} }));
    }
    expect(answers.at(-1)?.status).toBe(429);
    for (const answer of answers) {
      expect(answer.headers.get('cache-control')).toBe('no-store');
      expect(answer.headers.get('x-robots-tag')).toBe('noindex');
    }
  });

  test('each client has its own budget on each class of route, counted before anything is weighed', async () => {
    const wizard = await aWizard({ limits: 'real' });
    const classes: [string, number, () => Promise<Response>][] = [
      [
        'holder routes',
        SETUP_BUDGET.burst,
        async (): Promise<Response> =>
          await call(wizard, 'GET', '/setup/state', { client: '192.0.2.1' }),
      ],
      [
        'the claim',
        SETUP_SECRET_BUDGET.burst,
        async (): Promise<Response> =>
          await call(wizard, 'POST', '/setup/claim', { body: {}, client: '192.0.2.2' }),
      ],
      [
        'the address link',
        SETUP_SECRET_BUDGET.burst,
        async (): Promise<Response> =>
          await call(wizard, 'POST', '/setup/verify', { body: {}, client: '192.0.2.3' }),
      ],
      [
        'the status',
        AUTH_BUDGET.burst,
        async (): Promise<Response> =>
          await call(wizard, 'GET', '/setup/status', { client: '192.0.2.4' }),
      ],
    ];
    for (const [name, burst, ask] of classes) {
      for (let n = 0; n < burst; n += 1)
        expect([name, (await ask()).status]).not.toEqual([name, 429]);
      const over = await ask();
      expect([name, over.status]).toEqual([name, 429]);
      expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    // Another client is not held back by them.
    expect((await call(wizard, 'GET', '/setup/state', { client: '192.0.2.99' })).status).toBe(404);
    // A claim refused by the limit weighed no code: none was counted.
    const row = await wizard.db
      .selectFrom('setup_state')
      .select('failed_attempts')
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    expect(row.failed_attempts).toBe(0);
  });

  test('HEAD is charged as GET: the guard and the status are not asked without limit', async () => {
    const wizard = await aWizard({ limits: 'real' });
    for (const [path, burst] of [
      ['/setup/state', SETUP_BUDGET.burst],
      ['/setup/status', AUTH_BUDGET.burst],
    ] as const) {
      for (let n = 0; n < burst; n += 1) {
        expect((await call(wizard, 'HEAD', path, { client: '192.0.2.60' })).status).not.toBe(429);
      }
      const over = await call(wizard, 'HEAD', path, { client: '192.0.2.60' });
      expect([path, over.status]).toEqual([path, 429]);
      expect((await call(wizard, 'GET', path, { client: '192.0.2.60' })).status).toBe(429);
      expect((await call(wizard, 'GET', path, { client: '192.0.2.61' })).status).not.toBe(429);
    }
  });

  test('the five wrong codes a stranger can send from one client lock nothing more than the limit lets them', async () => {
    const wizard = await aWizard({ limits: 'real' });
    await wizard.start();
    for (let n = 0; n < SETUP_SECRET_BUDGET.burst + 5; n += 1) {
      await call(wizard, 'POST', '/setup/claim', {
        body: { code: 'WRONG' },
        client: '192.0.2.50',
      });
    }
    const row = await wizard.db
      .selectFrom('setup_state')
      .select(['failed_attempts', 'locked_until'])
      .where('id', '=', true)
      .executeTakeFirstOrThrow();
    // Ten requests reached the code: the fifth locked it, and the five after were refused by the lock.
    expect(row.locked_until).not.toBeNull();
    expect(row.failed_attempts).toBe(0);
  });
});

describe('integration: the page the link opens is the client’s', () => {
  test('GET /setup/verify is not an API route: it is the page, which reads the fragment', async () => {
    const wizard = await aWizard();
    const page = await call(wizard, 'GET', '/setup/verify');
    // No client is built into this test's application: the API's own 404 for a path it does not own.
    expect(page.status).toBe(404);
    expect(((await page.json()) as { error: { code: string } }).error.code).toBe('ROUTE_NOT_FOUND');
  });
});
