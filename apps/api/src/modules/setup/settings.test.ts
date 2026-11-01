/**
 * What the settings module decides without a database: what a view shows of a secret, what the
 * environment seeds, and which variables a start says it ignores (D-179 §6).
 */
import { describe, expect, test } from 'bun:test';
import { testConfig } from '../../testing/doubles';
import {
  envSeedOf,
  ignoredEnvironment,
  relayHost,
  settingsView,
  type ServerSettings,
} from './settings';

const SETTINGS: ServerSettings = {
  signUp: 'invite-only',
  github: { clientId: 'Iv1.app', clientSecret: 'gh-secret-value' },
  oidc: undefined,
  smtp: {
    smtpUrl: 'smtp://mailer:pa%3Ass@relay.example.com:587',
    from: 'purlay@example.com',
    allowPlaintext: true,
  },
  workspaceCreators: { kind: 'listed', logins: new Set(['ada', 'grace']) },
  setupCompletedAt: new Date('2026-10-22T09:00:00.000Z'),
  requireTwoFactor: false,
  passwordSignIn: true,
  sessionIdleTimeoutHours: null,
  sessionMaxAgeDays: null,
};

describe('the view of the settings, which is all a response may carry', () => {
  test('says a secret is set, and never what it is', () => {
    const view = settingsView(SETTINGS);
    expect(view).toEqual({
      signUp: 'invite-only',
      github: { clientId: 'Iv1.app', clientSecret: { set: true } },
      oidc: null,
      smtp: {
        // Where the relay is, and nothing of who signs in to it: some relays take a token as the user.
        address: { set: true, host: 'smtp://relay.example.com:587' },
        from: 'purlay@example.com',
        allowPlaintext: true,
      },
      workspaceCreators: { kind: 'listed', logins: ['ada', 'grace'] },
      setupCompletedAt: '2026-10-22T09:00:00.000Z',
      requireTwoFactor: false,
      passwordSignIn: true,
      sessionIdleTimeoutHours: null,
      sessionMaxAgeDays: null,
    });
    const written = JSON.stringify(view);
    expect(written).not.toContain('gh-secret-value');
    expect(written).not.toContain('pa%3Ass');
    expect(written).not.toContain('pa:ss');
    expect(written).not.toContain('mailer');
  });

  test('a server with nothing configured says so', () => {
    expect(
      settingsView({
        signUp: 'open',
        github: undefined,
        oidc: undefined,
        smtp: undefined,
        workspaceCreators: { kind: 'first' },
        setupCompletedAt: undefined,
        requireTwoFactor: false,
        passwordSignIn: true,
        sessionIdleTimeoutHours: null,
        sessionMaxAgeDays: null,
      }),
    ).toEqual({
      signUp: 'open',
      github: null,
      oidc: null,
      smtp: null,
      workspaceCreators: { kind: 'first' },
      setupCompletedAt: null,
      requireTwoFactor: false,
      passwordSignIn: true,
      sessionIdleTimeoutHours: null,
      sessionMaxAgeDays: null,
    });
  });

  test('has no field that could hold a secret: the type says so', () => {
    const view = settingsView(SETTINGS);
    // @ts-expect-error — the view's client secret is whether it is set, never a string.
    const secret: string = view.github?.clientSecret ?? '';
    expect(typeof secret).toBe('object');
  });
});

describe('the relay’s address, shown', () => {
  test('is its scheme, host and port: no user, no password, nothing else', () => {
    expect(relayHost('smtps://u%40x.com:secret@mail.example.com:465')).toBe(
      'smtps://mail.example.com:465',
    );
    expect(relayHost('smtp://localhost:25')).toBe('smtp://localhost:25');
    expect(relayHost('smtp://server-token:server-token@[::1]:25')).toBe('smtp://[::1]:25');
  });
});

describe('the environment, as the seed of the first start', () => {
  test('reads the GitHub app, the relay and who may make a workspace', () => {
    expect(
      envSeedOf(
        testConfig({
          GITHUB_CLIENT_ID: 'id',
          GITHUB_CLIENT_SECRET: 'secret',
          SMTP_URL: 'smtps://mail.example.com',
          MAIL_FROM: 'purlay@example.com',
          SMTP_ALLOW_PLAINTEXT: false,
          WORKSPACE_CREATORS: '*',
        }),
      ),
    ).toEqual({
      github: { clientId: 'id', clientSecret: 'secret' },
      smtp: {
        smtpUrl: 'smtps://mail.example.com',
        from: 'purlay@example.com',
        allowPlaintext: false,
      },
      workspaceCreators: { kind: 'anyone' },
    });
    const bare = testConfig();
    delete bare.WORKSPACE_CREATORS;
    expect(envSeedOf(bare)).toEqual({
      github: { clientId: 'client-id', clientSecret: 'client-secret' },
      workspaceCreators: { kind: 'first' },
    });
  });

  /** Each combination of the two optional integrations: what is seeded, and what a later start ignores. */
  describe.each<{
    name: string;
    env: Record<string, string>;
    seeded: string[];
    ignored: string[];
  }>([
    {
      name: 'GitHub only',
      env: { GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' },
      seeded: ['github'],
      ignored: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    },
    {
      name: 'mail only',
      env: { SMTP_URL: 'smtps://mail.example.com', MAIL_FROM: 'purlay@example.com' },
      seeded: ['smtp'],
      ignored: ['SMTP_URL', 'MAIL_FROM'],
    },
    {
      name: 'both',
      env: {
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: 'secret',
        SMTP_URL: 'smtps://mail.example.com',
        MAIL_FROM: 'purlay@example.com',
      },
      seeded: ['github', 'smtp'],
      ignored: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SMTP_URL', 'MAIL_FROM'],
    },
    { name: 'neither', env: {}, seeded: [], ignored: [] },
  ])('with $name in the environment', ({ env, seeded, ignored }) => {
    const config = (): ReturnType<typeof testConfig> => {
      const base = testConfig(env);
      delete base.WORKSPACE_CREATORS;
      if (!('GITHUB_CLIENT_ID' in env)) {
        delete base.GITHUB_CLIENT_ID;
        delete base.GITHUB_CLIENT_SECRET;
      }
      return base;
    };

    test('seeds exactly the integrations that are present', () => {
      const seed = envSeedOf(config());
      expect(Object.keys(seed).filter((key) => key !== 'workspaceCreators')).toEqual(seeded);
    });

    test('names exactly the variables that are set', () => {
      expect([...ignoredEnvironment(config())]).toEqual(ignored);
    });
  });

  test('half a GitHub app is not seeded: the configuration refuses it, and the seed does not guess', () => {
    const half = testConfig({ GITHUB_CLIENT_ID: 'id' });
    delete half.GITHUB_CLIENT_SECRET;
    expect(envSeedOf(half).github).toBeUndefined();
  });

  test('names the variables a later start ignores, and never their values', () => {
    const config = testConfig({
      GITHUB_CLIENT_SECRET: 'never-say-this',
      SMTP_URL: 'smtps://u:never-this-either@mail.example.com',
      MAIL_FROM: 'purlay@example.com',
      SMTP_ALLOW_PLAINTEXT: true,
      WORKSPACE_CREATORS: 'ada',
    });
    const ignored = ignoredEnvironment(config);
    expect(ignored).toEqual([
      'GITHUB_CLIENT_ID',
      'GITHUB_CLIENT_SECRET',
      'SMTP_URL',
      'MAIL_FROM',
      'SMTP_ALLOW_PLAINTEXT',
      'WORKSPACE_CREATORS',
    ]);
    expect(JSON.stringify(ignored)).not.toContain('never');
    const quiet = testConfig();
    delete quiet.WORKSPACE_CREATORS;
    expect(ignoredEnvironment(quiet)).toEqual(['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']);
  });
});
