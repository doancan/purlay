/**
 * A server whose sign-in and mail are built from the settings in the database (D-179 §6) behaves as the
 * one built from the environment did: GitHub signs a person in with the app the settings name, who may
 * sign up is the settings' choice, and letters go through the relay they name, from their sender.
 *
 * On a clone: the library's sign-up is a transaction of its own (`github-sign-in.ts`). GitHub is the
 * strict stand-in on a loopback port, reached through the platform's own `fetch`; the relay is one on
 * this machine that records what it is told.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cloneIntegrationDatabase, type ClonedDatabase, CLONE_HOOK_MS } from '@purlay/db';
import { createApp } from './app';
import { systemClock } from '../../platform/clock';
import { DEVELOPMENT_ENCRYPTION_KEY } from '../../platform/config';
import { credentialCipher } from '../../platform/crypto';
import { NO_LOG } from '../../platform/events';
import { createLogger } from '../../platform/logging';
import { deriveAuthSecret } from '../../modules/auth/better-auth';
import { inProcessEventBus } from '../../realtime/bus';
import { testConfig, testDependencies } from '../../testing/doubles';
import { aGitHubPerson, cookiesFrom } from '../../testing/github-sign-in';
import { aGitHubStub, GITHUB_STUB_CREDENTIALS, type GitHubStub } from '../../testing/github-stub';
import { aRelay } from '../../testing/relay';
import { readSettings, readSettingsToBoot, saveSettings } from '../../modules/setup/settings';
import { runtimeServicesFrom, type RuntimeServices } from '../../modules/setup/runtime';

const ORIGIN = 'https://purlay.test';
const cipher = credentialCipher(DEVELOPMENT_ENCRYPTION_KEY);
const silent = createLogger({ level: 'silent' });

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
});

/** What the composition root builds, from what the database says now, with GitHub at `githubUrl`. */
const servicesFromTheDatabase = async (githubUrl: string): Promise<RuntimeServices> =>
  runtimeServicesFrom(await readSettings(cloned.db, cipher), {
    database: cloned.db,
    baseUrl: ORIGIN,
    secret: deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY),
    log: silent,
    githubUrls: { web: githubUrl, api: githubUrl },
    sessionTtlDays: 30,
    bus: inProcessEventBus(() => undefined, NO_LOG),
    clock: systemClock,
  });

/** The button, GitHub's Authorize, and the callback, as a browser makes them: where it lands. */
const signIn = async (services: RuntimeServices): Promise<string | null> => {
  const app = createApp(
    testDependencies({
      database: cloned.db,
      config: testConfig({ APP_URL: ORIGIN }),
      auth: services.auth,
    }),
  );
  const button = await app.handle(new Request(`${ORIGIN}/auth/github`));
  const granted = await fetch(button.headers.get('location') ?? '', { redirect: 'manual' });
  const back = await app.handle(
    new Request(granted.headers.get('location') ?? '', {
      headers: { cookie: cookiesFrom(button) },
    }),
  );
  return back.headers.get('location');
};

const withGitHub = async (
  github: GitHubStub,
  body: (url: string) => Promise<void>,
): Promise<void> => {
  const served = github.serve(0);
  try {
    await body(served.url);
  } finally {
    served.stop();
  }
};

describe('integration: a server built from its settings', () => {
  test('signs in with the GitHub app the settings name, and sign-up is theirs to open', async () => {
    await saveSettings(cloned.db, cipher, systemClock, {
      github: GITHUB_STUB_CREDENTIALS,
      signUp: 'invite-only',
      smtp: null,
    });
    const closed = aGitHubPerson();
    await withGitHub(aGitHubStub(closed), async (url) => {
      // Invite-only: a stranger is turned away, as the environment-built server turned them.
      expect(await signIn(await servicesFromTheDatabase(url))).toBe(
        `${ORIGIN}/sign-in?error=signup-closed`,
      );
    });

    await saveSettings(cloned.db, cipher, systemClock, { signUp: 'open' });
    const open = aGitHubPerson();
    const github = aGitHubStub(open);
    await withGitHub(github, async (url) => {
      expect(await signIn(await servicesFromTheDatabase(url))).toBe(ORIGIN);
    });
    expect(github.refusals).toEqual([]);
    const made = await cloned.db
      .selectFrom('users')
      .select('github_login')
      .where('email', '=', open.email)
      .executeTakeFirstOrThrow();
    expect(made.github_login).toBe(open.login);
  });

  test('a GitHub secret the settings hold that GitHub does not know signs nobody in', async () => {
    await saveSettings(cloned.db, cipher, systemClock, {
      github: { clientId: GITHUB_STUB_CREDENTIALS.clientId, clientSecret: 'an-old-secret' },
      signUp: 'open',
    });
    const github = aGitHubStub(aGitHubPerson());
    await withGitHub(github, async (url) => {
      expect(await signIn(await servicesFromTheDatabase(url))).toBe(
        `${ORIGIN}/sign-in?error=github-unavailable`,
      );
    });
    expect(github.refusals).toEqual(['incorrect_client_credentials']);
  });

  test('mails through the relay the settings name, from their sender; without one, there is no mail', async () => {
    const relay = aRelay();
    try {
      await saveSettings(cloned.db, cipher, systemClock, {
        smtp: {
          smtpUrl: `smtp://127.0.0.1:${String(relay.port)}`,
          from: 'no-reply@purlay.test',
          allowPlaintext: false,
        },
      });
      const services = await servicesFromTheDatabase('https://github.com');
      // Sign-in by link is installed where there is a relay, and the screen offers it (D-138 §6).
      expect(services.auth.signInLinks?.outbox).toBe(services.mail);
      const app = createApp(testDependencies({ auth: services.auth }));
      expect(await (await app.handle(new Request(`${ORIGIN}/api/auth/methods`))).json()).toEqual({
        github: true,
        email: true,
        oidc: null,
        signUp: 'open',
      });
      services.mail?.post(
        { to: 'ada@example.test', subject: 'A letter', text: 'words', html: '<p>words</p>' },
        'test',
      );
      await services.mail?.flush();
      expect(relay.commands.filter((line) => /^(MAIL|RCPT)/i.test(line))).toEqual([
        'MAIL FROM:<no-reply@purlay.test>',
        'RCPT TO:<ada@example.test>',
      ]);
    } finally {
      relay.stop();
    }

    await saveSettings(cloned.db, cipher, systemClock, { smtp: null });
    const without = await servicesFromTheDatabase('https://github.com');
    expect([without.mail, without.mailer, without.auth.signInLinks]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    const app = createApp(testDependencies({ auth: without.auth }));
    expect(await (await app.handle(new Request(`${ORIGIN}/api/auth/methods`))).json()).toEqual({
      github: true,
      email: false,
      oidc: null,
      signUp: 'open',
    });
  });

  test('a server with no GitHub app and no relay builds, serves, and waits for its setup', async () => {
    await saveSettings(cloned.db, cipher, systemClock, { github: null, smtp: null });
    const services = await servicesFromTheDatabase('https://github.com');
    expect([services.auth.github, services.auth.signInLinks, services.mail]).toEqual([
      false,
      undefined,
      undefined,
    ]);
    expect(services.needsReentry).toEqual([]);
    const app = createApp(testDependencies({ database: cloned.db, auth: services.auth }));
    expect(await (await app.handle(new Request(`${ORIGIN}/api/auth/methods`))).json()).toEqual({
      github: false,
      email: false,
      oidc: null,
      signUp: 'open',
    });
    const button = await app.handle(new Request(`${ORIGIN}/auth/github`));
    expect([button.status, button.headers.get('location')]).toEqual([404, null]);
    expect(await button.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND' } });
    expect((await app.handle(new Request(`${ORIGIN}/health`))).status).toBe(200);
  });

  test('what the settings could not open is carried by the services, and the server is built without it', async () => {
    await saveSettings(cloned.db, cipher, systemClock, {
      github: GITHUB_STUB_CREDENTIALS,
      smtp: null,
    });
    const other = credentialCipher(
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    );
    const { settings, needsReentry } = await readSettingsToBoot(cloned.db, other);
    const services = runtimeServicesFrom(
      settings,
      {
        database: cloned.db,
        baseUrl: ORIGIN,
        secret: deriveAuthSecret(DEVELOPMENT_ENCRYPTION_KEY),
        log: silent,
        githubUrls: { web: 'https://github.com', api: 'https://api.github.com' },
        sessionTtlDays: 30,
        bus: inProcessEventBus(() => undefined, NO_LOG),
        clock: systemClock,
      },
      needsReentry,
    );
    expect([services.needsReentry, services.auth.github]).toEqual([['github'], false]);
  });
});
