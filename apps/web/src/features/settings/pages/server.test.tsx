/**
 * Settings → Server (`UX.md` §11, D-179 §4.8), through the real frame at the page's address: offered to
 * the server's administrator alone — a workspace's owner is not one, and the address is *not found* for
 * everybody else — each card's states, the wizard's own sentence per reason of a failed try (and nothing
 * kept), the question before a way in is disconnected (the strong one when it is the last), and the line
 * on a card whose secret the key could not open.
 */
import { SessionGate, useSession } from '../../session/session';
import { Shell } from '../../shell/shell';
import { NotFound } from '../../shell/not-found';
import { SettingsPage } from '../page';
import { ServerSettingsState } from './server';
import { GitHubCard, EmailCard } from './server-channels';
import { GoogleCard } from './server-google';
import { OidcCard } from './server-oidc';
import { GitHubAppCard } from './server-github-app';
import { CreatorsCard, PolicyCard, SignInPolicyCard, SessionLifetimeCard } from './server-policies';
import { AccountsCard } from './server-accounts';
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import {
  PROBE_REASONS,
  type ProbeResult,
  type ServerAccount,
  type ServerSettingsAnswer,
} from '@purlay/types';
import { en } from '../../../i18n/catalogue/en';
import { tr } from '../../../i18n/catalogue/tr';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { SetupFailure } from '../../setup/client';
import { REASONS, reasonWords } from '../../setup/errors';
import type { ServerClient } from '../server-client';
import { SERVER_SETTINGS_KEY, ServerClientProvider } from '../server-context';

installDom();

type Scope = BoundFunctions<typeof queries>;
type View = Awaited<ReturnType<typeof renderApp>>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const anAnswer = (over: Partial<ServerSettingsAnswer> = {}): ServerSettingsAnswer => ({
  settings: {
    signUp: 'invite-only',
    requireTwoFactor: false,
    passwordSignIn: true,
    sessionIdleTimeoutHours: null,
    sessionMaxAgeDays: null,
    github: null,
    oidc: null,
    google: null,
    smtp: null,
    githubApp: null,
    workspaceCreators: { kind: 'first' },
    setupCompletedAt: '2026-10-01T00:00:00.000Z',
  },
  needsReentry: [],
  appUrl: 'https://purlay.test',
  githubCallbackUrl: 'https://purlay.test/auth/callback/github',
  oidcCallbackUrl: 'https://purlay.test/auth/callback/oidc',
  googleCallbackUrl: 'https://purlay.test/auth/callback/google',
  githubApp: {
    callbackUrl: 'https://purlay.test/api/github-app/callback',
    webhookUrl: 'https://purlay.test/api/webhooks/github-app',
  },
  channels: { github: false, email: false, oidc: false, google: false },
  adminEmail: 'admin@example.test',
  ...over,
});

const CONNECTED = anAnswer({
  settings: {
    signUp: 'open',
    requireTwoFactor: false,
    passwordSignIn: true,
    sessionIdleTimeoutHours: null,
    sessionMaxAgeDays: null,
    github: { clientId: 'Iv1.abc123', clientSecret: { set: true } },
    oidc: null,
    google: null,
    smtp: {
      address: { set: true, host: 'smtp://mail.example.test:587' },
      from: 'purlay@example.test',
      allowPlaintext: false,
    },
    githubApp: null,
    workspaceCreators: { kind: 'listed', logins: ['ada', 'grace'] },
    setupCompletedAt: '2026-10-01T00:00:00.000Z',
  },
  channels: { github: true, email: true, oidc: false, google: false },
});

const unexpected = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`the test did not expect client.${name} to be called`));

const aClient = (over: Partial<ServerClient> = {}): ServerClient => ({
  settings: () => Promise.resolve(anAnswer()),
  github: unexpected('github'),
  oidc: unexpected('oidc'),
  google: unexpected('google'),
  smtp: unexpected('smtp'),
  githubApp: unexpected('githubApp'),
  disconnect: unexpected('disconnect'),
  policy: unexpected('policy'),
  creators: unexpected('creators'),
  // The Accounts card asks on every visit: nobody, unless a test says.
  accounts: () => Promise.resolve([]),
  suspend: unexpected('suspend'),
  lift: unexpected('lift'),
  ...over,
});

/** Test-only card composition: production categorizes these across the independent console. */
const ProviderCards = (): React.JSX.Element =>
  useSession().isServerAdmin ? (
    <SettingsPage title="Server" description={en['settings.server.description']}>
      <ServerSettingsState>
        {(view) => (
          <>
            <GitHubCard view={view} />
            <GoogleCard view={view} />
            <OidcCard view={view} />
            <EmailCard view={view} />
            <GitHubAppCard view={view} />
            <PolicyCard view={view} />
            <SignInPolicyCard view={view} />
            <SessionLifetimeCard view={view} />
            <CreatorsCard view={view} />
            <AccountsCard />
          </>
        )}
      </ServerSettingsState>
    </SettingsPage>
  ) : (
    <NotFound />
  );

const render = async (
  client: ServerClient,
  { admin = true, owner = true }: { admin?: boolean; owner?: boolean } = {},
): Promise<View> => {
  const session = aSession();
  const view = await renderApp(
    <ServerClientProvider value={client}>
      <SessionGate>
        <Shell slug="acme">
          <ProviderCards />
        </Shell>
      </SessionGate>
    </ServerClientProvider>,
    {
      path: '/w/acme/settings/server',
      api: aSignedInApi({
        me: () =>
          Promise.resolve({
            ...session,
            isServerAdmin: admin,
            memberships: session.memberships.map((m) => ({
              ...m,
              role: owner ? 'owner' : 'member',
            })),
          }),
      }),
    },
  );
  await settle();
  return view;
};

const main = (view: View): Scope => within(view.getByRole('main'));
const card = (view: View, name: string): Scope => within(main(view).getByRole('region', { name }));

describe('Settings → Server', () => {
  test('is the server administrator’s alone: a workspace owner who is not one is offered nothing, and the address is not found', async () => {
    const view = await render(aClient({ settings: unexpected('settings') }), { admin: false });
    expect(await view.findByText('Nothing here')).toBeDefined();
    expect(view.queryByRole('link', { name: 'Server' })).toBeNull();
    view.unmount();
  });

  test('is offered to the administrator, in the navigation under its own heading, even as a mere member', async () => {
    const view = await render(aClient(), { owner: false });
    expect(await view.findByRole('heading', { level: 1, name: 'Server' })).toBeDefined();
    expect(view.getByRole('link', { name: 'Server' }).getAttribute('aria-current')).toBe('page');
    // The workspace's own pages are not offered to a member: the two are different questions.
    expect(view.queryByRole('link', { name: 'General' })).toBeNull();
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test('says each state: loading, a failed read with Retry, and nothing connected', async () => {
    let calls = 0;
    const view = await render(
      aClient({
        settings: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new SetupFailure(500, 'INTERNAL', 'no'))
            : Promise.resolve(anAnswer());
        },
      }),
    );
    expect(await view.findByText('Could not read the server settings')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    const github = card(view, 'Sign in with GitHub');
    expect(github.getByText('Not connected')).toBeDefined();
    expect(github.getByText(en['settings.server.github.empty'])).toBeDefined();
    expect(github.getByRole('button', { name: 'Connect GitHub' })).toBeDefined();
    expect(card(view, 'E-mail').getByText('Not connected')).toBeDefined();
    view.unmount();
  });

  test('shows what is connected without any secret, and the address to paste', async () => {
    const view = await render(aClient({ settings: () => Promise.resolve(CONNECTED) }));
    const page = view.getByRole('main');
    expect(card(view, 'Sign in with GitHub').getByText('Client ID Iv1.abc123')).toBeDefined();
    expect(page.textContent).toContain('https://purlay.test/auth/callback/github');
    expect(
      card(view, 'E-mail').getByText('Mail server smtp://mail.example.test:587'),
    ).toBeDefined();
    expect(card(view, 'E-mail').getByText('purlay@example.test')).toBeDefined();
    expect(page.textContent).not.toContain('secret');
    view.unmount();
  });

  test.each(PROBE_REASONS)(
    'a GitHub or relay try that fails for %s is said in the wizard’s words, and keeps the form',
    async (reason) => {
      const failed: ProbeResult = { ok: false, reason, raw: 'the service said no' };
      const view = await render(
        aClient({ github: () => Promise.resolve(failed), smtp: () => Promise.resolve(failed) }),
      );
      const github = card(view, 'Sign in with GitHub');
      await person().click(github.getByRole('button', { name: 'Connect GitHub' }));
      await person().type(github.getByLabelText('Client ID'), 'id');
      await person().type(github.getByLabelText('Client secret'), 'secret');
      await person().click(github.getByRole('button', { name: 'Try the connection and save' }));
      await settle();
      expect(github.getByText(en[REASONS[reason].what])).toBeDefined();
      expect(github.getByText('the service said no')).toBeDefined();
      // Kept: what was typed, and a way to try again.
      expect(github.getByLabelText<HTMLInputElement>('Client ID').value).toBe('id');
      expect(github.getByRole('button', { name: 'Try again' })).toBeDefined();
      view.unmount();
    },
  );

  test('a GitHub app that works is sent as typed, the form closes, and the card says it was saved', async () => {
    const sent: unknown[] = [];
    let saved = false;
    const view = await render(
      aClient({
        settings: () => Promise.resolve(saved ? CONNECTED : anAnswer()),
        github: (candidate) => {
          sent.push(candidate);
          saved = true;
          return Promise.resolve({ ok: true });
        },
      }),
    );
    const github = card(view, 'Sign in with GitHub');
    await person().click(github.getByRole('button', { name: 'Connect GitHub' }));
    await person().type(github.getByLabelText('Client ID'), '  Iv1.abc123 ');
    await person().type(github.getByLabelText('Client secret'), 'shh-secret');
    await person().click(github.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(sent).toEqual([{ clientId: 'Iv1.abc123', clientSecret: 'shh-secret' }]);
    expect(github.getByText('Saved. GitHub sign-in uses this app from now on.')).toBeDefined();
    expect(github.queryByLabelText('Client secret')).toBeNull();
    expect(github.getByText('Client ID Iv1.abc123')).toBeDefined();
    view.unmount();
  });

  test('the relay card says where the test message goes, and sends nothing it was not asked', async () => {
    const sent: unknown[] = [];
    const view = await render(
      aClient({
        smtp: (candidate) => {
          sent.push(candidate);
          return Promise.resolve({ ok: true });
        },
      }),
    );
    const email = card(view, 'E-mail');
    await person().click(email.getByRole('button', { name: 'Connect a mail server' }));
    expect(email.getByText('We will send a test message to admin@example.test.')).toBeDefined();
    expect(sent).toEqual([]);
    await person().click(email.getByRole('button', { name: 'Use an SMTP URL' }));
    await person().type(email.getByLabelText('Mail server'), 'smtp://u:p@mail.example.test');
    await person().type(email.getByLabelText('Sender'), 'purlay@example.test');
    await person().click(email.getByRole('button', { name: 'Send a test message and save' }));
    await settle();
    expect(sent).toEqual([
      {
        smtpUrl: 'smtp://u:p@mail.example.test',
        from: 'purlay@example.test',
        allowPlaintext: false,
      },
    ]);
    view.unmount();
  });

  test('a secret the key could not open says so on its card, and opens the form to enter it again', async () => {
    const view = await render(
      aClient({ settings: () => Promise.resolve(anAnswer({ needsReentry: ['github'] })) }),
    );
    const github = card(view, 'Sign in with GitHub');
    expect(
      github.getByText('This secret could not be opened with the current key — enter it again.'),
    ).toBeDefined();
    expect(github.getByLabelText('Client secret')).toBeDefined();
    // It can also be let go: the same question as for a connected one.
    await person().click(github.getByRole('button', { name: 'Disconnect' }));
    expect(within(view.getByRole('dialog')).getByText('Disconnect GitHub sign-in?')).toBeDefined();
    await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(
      within(main(view).getByRole('region', { name: 'E-mail' })).queryByText(
        'This secret could not be opened with the current key — enter it again.',
      ),
    ).toBeNull();
    view.unmount();
  });

  test('disconnecting asks first; with the mail server still there it is the plain question', async () => {
    const asked: [string, boolean][] = [];
    const view = await render(
      aClient({
        settings: () => Promise.resolve(CONNECTED),
        disconnect: (channel, confirm) => {
          asked.push([channel, confirm]);
          return Promise.resolve();
        },
      }),
    );
    await person().click(
      within(main(view).getByRole('region', { name: 'Sign in with GitHub' })).getByRole('button', {
        name: 'Disconnect',
      }),
    );
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.getByText('Disconnect GitHub sign-in?')).toBeDefined();
    expect(dialog.queryByText(en['settings.server.lastWay'])).toBeNull();
    expect(asked).toEqual([]);
    await person().click(dialog.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(asked).toEqual([['github', false]]);
    view.unmount();
  });

  test('disconnecting the last way in says so before, and says it outright to the server', async () => {
    const asked: [string, boolean][] = [];
    const only = anAnswer({
      settings: { ...CONNECTED.settings, smtp: null },
      channels: { github: true, email: false, oidc: false, google: false },
    });
    const view = await render(
      aClient({
        settings: () => Promise.resolve(only),
        disconnect: (channel, confirm) => {
          asked.push([channel, confirm]);
          return Promise.resolve();
        },
      }),
    );
    await person().click(
      within(main(view).getByRole('region', { name: 'Sign in with GitHub' })).getByRole('button', {
        name: 'Disconnect',
      }),
    );
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.getByText(en['settings.server.lastWay'])).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Disconnect anyway' }));
    await settle();
    expect(asked).toEqual([['github', true]]);
    view.unmount();
  });

  test('a disconnect the server refuses as the last way in — changed under the page — turns into that question and takes nothing', async () => {
    const asked: [string, boolean][] = [];
    const view = await render(
      aClient({
        settings: () => Promise.resolve(CONNECTED),
        disconnect: (channel, confirm) => {
          asked.push([channel, confirm]);
          return confirm
            ? Promise.resolve()
            : Promise.reject(
                new SetupFailure(
                  409,
                  'SERVER_CHANGE_REFUSED',
                  'no',
                  null,
                  {},
                  null,
                  'last-channel',
                ),
              );
        },
      }),
    );
    await person().click(
      within(main(view).getByRole('region', { name: 'E-mail' })).getByRole('button', {
        name: 'Disconnect',
      }),
    );
    const dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(dialog.getByText(en['settings.server.lastWay'])).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Disconnect anyway' }));
    await settle();
    expect(asked).toEqual([
      ['smtp', false],
      ['smtp', true],
    ]);
    view.unmount();
  });

  test('the sign-up policy applies as it is chosen, with its one sentence', async () => {
    const asked: unknown[] = [];
    const view = await render(
      aClient({
        policy: (change) => {
          asked.push(change);
          return Promise.resolve();
        },
      }),
    );
    const policy = card(view, 'Who can create an account');
    expect(policy.getByText(en['settings.server.policy.open.body'])).toBeDefined();
    await person().click(policy.getByRole('radio', { name: /Anyone/ }));
    await settle();
    expect(asked).toEqual([{ signUp: 'open' }]);
    expect(policy.getByText('Saved. This applies from the next sign-up.')).toBeDefined();
    view.unmount();
  });

  test('how people sign in (D-239): each rule applies on its own as it is chosen, and the policy is read again', async () => {
    const asked: unknown[] = [];
    let now = CONNECTED;
    const view = await render(
      aClient({
        settings: () => Promise.resolve(now),
        policy: (change) => {
          asked.push(change);
          now = anAnswer({ ...now, settings: { ...now.settings, ...change } });
          return Promise.resolve();
        },
      }),
    );
    const signIn = card(view, 'How people sign in');
    expect(signIn.getByRole('radio', { name: /Optional/ })).toHaveProperty('checked', true);
    expect(signIn.getByRole('radio', { name: /^On/ })).toHaveProperty('checked', true);
    await person().click(signIn.getByRole('radio', { name: /Required/ }));
    await settle();
    await person().click(signIn.getByRole('radio', { name: /^Off/ }));
    await settle();
    expect(asked).toEqual([{ requireTwoFactor: true }, { passwordSignIn: false }]);
    expect(signIn.getByRole('radio', { name: /Required/ })).toHaveProperty('checked', true);
    expect(signIn.getByRole('radio', { name: /^Off/ })).toHaveProperty('checked', true);
    expect(signIn.getByText(en['settings.server.signIn.saved'])).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('passwords cannot be turned off with none of GitHub, Google and single sign-on: said before, and the refusal in its words', async () => {
    const view = await render(
      aClient({
        policy: () =>
          Promise.reject(
            new SetupFailure(409, 'SERVER_CHANGE_REFUSED', 'no', null, {}, null, 'no-provider'),
          ),
      }),
    );
    const signIn = card(view, 'How people sign in');
    const needs = en['settings.server.signIn.passwords.needsProvider'];
    expect(signIn.getAllByText(needs)).toHaveLength(1);
    await person().click(signIn.getByRole('radio', { name: /^Off/ }));
    await settle();
    // The row's sentence, and the refusal's: the choice goes back to what the server holds.
    expect(signIn.getAllByText(needs)).toHaveLength(2);
    expect(signIn.getByRole('radio', { name: /^On/ })).toHaveProperty('checked', true);
    view.unmount();
  });

  test('with passwords off, the last of GitHub, Google and single sign-on is not offered to be disconnected (D-239)', async () => {
    const view = await render(
      aClient({
        settings: () =>
          Promise.resolve(
            anAnswer({
              ...CONNECTED,
              settings: { ...CONNECTED.settings, passwordSignIn: false },
            }),
          ),
      }),
    );
    await person().click(
      within(main(view).getByRole('region', { name: 'Sign in with GitHub' })).getByRole('button', {
        name: 'Disconnect',
      }),
    );
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.getByText(en['settings.server.passwordsOffLast'])).toBeDefined();
    expect(dialog.queryByRole('button', { name: /Disconnect/ })).toBeNull();
    view.unmount();
  });

  test('how long a session lasts (D-244): each rule offers only what the server takes, and applies on its own as it is chosen', async () => {
    const asked: unknown[] = [];
    let now = anAnswer();
    const view = await render(
      aClient({
        settings: () => Promise.resolve(now),
        policy: (change) => {
          asked.push(change);
          now = anAnswer({ ...now, settings: { ...now.settings, ...change } });
          return Promise.resolve();
        },
      }),
    );
    const lifetime = card(view, 'How long a session lasts');
    const idle = lifetime.getByRole('combobox', { name: 'Sign out when unused for' });
    const maxAge = lifetime.getByRole('combobox', { name: 'Sign in again after' });
    const optionsOf = (select: HTMLElement): string[] =>
      within(select)
        .getAllByRole('option')
        .map((option) => option.textContent);
    expect(optionsOf(idle)).toEqual(['Never', '1 hour', '8 hours', '1 day', '1 week']);
    expect(optionsOf(maxAge)).toEqual([
      'Only the server’s own lifetime',
      '1 day',
      '1 week',
      '30 days',
      '90 days',
    ]);
    expect(idle).toHaveProperty('value', 'off');

    await person().selectOptions(idle, '8 hours');
    await settle();
    await person().selectOptions(maxAge, '30 days');
    await settle();
    await person().selectOptions(idle, 'Never');
    await settle();
    expect(asked).toEqual([
      { sessionIdleTimeoutHours: 8 },
      { sessionMaxAgeDays: 30 },
      { sessionIdleTimeoutHours: null },
    ]);
    expect(idle).toHaveProperty('value', 'off');
    expect(maxAge).toHaveProperty('value', '30');
    expect(lifetime.getByText(en['settings.server.signIn.saved'])).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a session rule the server refuses is said on its card, and the choice goes back to what it holds', async () => {
    const view = await render(
      aClient({
        policy: () =>
          Promise.reject(
            new SetupFailure(
              409,
              'SERVER_CHANGE_REFUSED',
              'no',
              null,
              {},
              null,
              'setup-unfinished',
            ),
          ),
      }),
    );
    const lifetime = card(view, 'How long a session lasts');
    const idle = lifetime.getByRole('combobox', { name: 'Sign out when unused for' });
    await person().selectOptions(idle, '1 hour');
    await settle();
    expect(lifetime.queryByText(en['settings.server.signIn.saved'])).toBeNull();
    expect(lifetime.getByText(en['settings.server.setupUnfinished'])).toBeDefined();
    expect(idle).toHaveProperty('value', 'off');
    view.unmount();
  });

  test('who may create workspaces: a list is held to GitHub logins before it is sent, and saved as typed', async () => {
    const asked: unknown[] = [];
    const view = await render(
      aClient({
        creators: (choice) => {
          asked.push(choice);
          return Promise.resolve();
        },
      }),
    );
    const creators = card(view, 'Who can create workspaces');
    const save = creators.getByRole('button', { name: 'Save' });
    expect(save).toHaveProperty('disabled', true);
    await person().click(creators.getByRole('radio', { name: /Only these GitHub accounts/ }));
    await person().type(creators.getByLabelText('GitHub logins'), 'not a login!');
    await person().click(save);
    expect(creators.getByText(en['settings.server.creators.loginsError'])).toBeDefined();
    expect(asked).toEqual([]);
    await person().clear(creators.getByLabelText('GitHub logins'));
    await person().type(creators.getByLabelText('GitHub logins'), 'Ada-L, grace');
    await person().click(save);
    await settle();
    expect(asked).toEqual([{ kind: 'listed', logins: ['Ada-L', 'grace'] }]);
    view.unmount();
  });

  test('a setup still open is said, not shown as a failure to try again', async () => {
    const view = await render(
      aClient({
        policy: () =>
          Promise.reject(
            new SetupFailure(
              409,
              'SERVER_CHANGE_REFUSED',
              'no',
              null,
              {},
              null,
              'setup-unfinished',
            ),
          ),
      }),
    );
    await person().click(
      card(view, 'Who can create an account').getByRole('radio', { name: /Anyone/ }),
    );
    await settle();
    expect(view.getByText(en['settings.server.setupUnfinished'])).toBeDefined();
    view.unmount();
  });
});

describe('Settings → Server, the forms and what stops them', () => {
  const openGithub = async (client: ServerClient): Promise<{ view: View; github: Scope }> => {
    const view = await render(client);
    const github = card(view, 'Sign in with GitHub');
    await person().click(github.getByRole('button', { name: 'Connect GitHub' }));
    await person().type(github.getByLabelText('Client ID'), 'id');
    await person().type(github.getByLabelText('Client secret'), 'secret');
    return { view, github };
  };

  const openEmail = async (client: ServerClient): Promise<{ view: View; email: Scope }> => {
    const view = await render(client);
    const email = card(view, 'E-mail');
    await person().click(email.getByRole('button', { name: 'Connect a mail server' }));
    await person().click(email.getByRole('button', { name: 'Use an SMTP URL' }));
    await person().type(email.getByLabelText('Mail server'), 'smtp://mail.example.test');
    await person().type(email.getByLabelText('Sender'), 'purlay@example.test');
    return { view, email };
  };

  test('connection credentials cannot change while their probe is in flight', async () => {
    for (const kind of ['github', 'smtp'] as const) {
      const client = aClient({ [kind]: () => new Promise(() => undefined) });
      const opened = kind === 'github' ? await openGithub(client) : await openEmail(client);
      const scope = 'github' in opened ? opened.github : opened.email;
      const submit = scope
        .getAllByRole<HTMLButtonElement>('button')
        .find((button) => button.type === 'submit');
      if (submit === undefined) throw new Error('missing connection submit');
      await person().click(submit);
      expect(
        scope.getByLabelText<HTMLInputElement>(kind === 'github' ? 'Client secret' : 'Mail server')
          .readOnly,
      ).toBe(true);
      opened.view.unmount();
    }
  });

  test('a GitHub try that never reached the server says so, and keeps what was typed', async () => {
    const { view, github } = await openGithub(
      aClient({ github: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')) }),
    );
    await person().click(github.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(github.getByText(en['setup.failed.network'])).toBeDefined();
    expect(github.getByLabelText<HTMLInputElement>('Client ID').value).toBe('id');
    view.unmount();
  });

  test('Cancel closes the GitHub form and forgets the failed try', async () => {
    const failed: ProbeResult = { ok: false, reason: 'unreachable', raw: 'no route' };
    const { view, github } = await openGithub(aClient({ github: () => Promise.resolve(failed) }));
    await person().click(github.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(github.getByText('no route')).toBeDefined();
    await person().click(github.getByRole('button', { name: 'Cancel' }));
    expect(github.queryByLabelText('Client secret')).toBeNull();
    expect(github.queryByText('no route')).toBeNull();
    await person().click(github.getByRole('button', { name: 'Connect GitHub' }));
    expect(github.queryByText('no route')).toBeNull();
    view.unmount();
  });

  test('a mail try that never reached the server says so, and keeps what was typed', async () => {
    const { view, email } = await openEmail(
      aClient({ smtp: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')) }),
    );
    await person().click(email.getByRole('button', { name: 'Send a test message and save' }));
    await settle();
    expect(email.getByText(en['setup.failed.network'])).toBeDefined();
    expect(email.getByLabelText<HTMLInputElement>('Sender').value).toBe('purlay@example.test');
    view.unmount();
  });

  test('Cancel closes the mail form and forgets the failed try', async () => {
    const failed: ProbeResult = { ok: false, reason: 'auth-failed', raw: '535 denied' };
    const { view, email } = await openEmail(aClient({ smtp: () => Promise.resolve(failed) }));
    await person().click(email.getByRole('button', { name: 'Send a test message and save' }));
    await settle();
    expect(email.getByText('535 denied')).toBeDefined();
    await person().click(email.getByRole('button', { name: 'Cancel' }));
    expect(email.queryByLabelText('Mail server')).toBeNull();
    expect(email.queryByText('535 denied')).toBeNull();
    view.unmount();
  });

  test('a mail try while setup is still open says that, not a failure to try again', async () => {
    const { view, email } = await openEmail(
      aClient({
        smtp: () =>
          Promise.reject(
            new SetupFailure(
              409,
              'SERVER_CHANGE_REFUSED',
              'no',
              null,
              {},
              null,
              'setup-unfinished',
            ),
          ),
      }),
    );
    await person().click(email.getByRole('button', { name: 'Send a test message and save' }));
    await settle();
    expect(email.getByText(en['settings.server.setupUnfinished'])).toBeDefined();
    view.unmount();
  });

  test('sends a mail server that needs no encryption only once it was said to be allowed', async () => {
    const sent: unknown[] = [];
    const { view, email } = await openEmail(
      aClient({
        smtp: (candidate) => {
          sent.push(candidate);
          return Promise.resolve({ ok: true });
        },
      }),
    );
    await person().click(
      email.getByRole('checkbox', { name: new RegExp(en['setup.email.plaintext']) }),
    );
    await person().click(email.getByRole('button', { name: 'Send a test message and save' }));
    await settle();
    expect(sent).toEqual([
      { smtpUrl: 'smtp://mail.example.test', from: 'purlay@example.test', allowPlaintext: true },
    ]);
    view.unmount();
  });

  test('a mail secret the key could not open can be let go, with the mail server’s question', async () => {
    const view = await render(
      aClient({ settings: () => Promise.resolve(anAnswer({ needsReentry: ['smtp'] })) }),
    );
    const email = card(view, 'E-mail');
    expect(email.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await person().click(email.getByRole('button', { name: 'Disconnect' }));
    expect(
      within(view.getByRole('dialog')).getByText(en['settings.server.email.disconnectTitle']),
    ).toBeDefined();
    view.unmount();
  });

  test('a question being answered cannot be dismissed with Escape until the server has answered', async () => {
    let finish: () => void = () => undefined;
    const asked: [string, boolean][] = [];
    const view = await render(
      aClient({
        settings: () => Promise.resolve(CONNECTED),
        disconnect: (channel, confirm) => {
          asked.push([channel, confirm]);
          return new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
      }),
    );
    await person().click(
      card(view, 'Sign in with GitHub').getByRole('button', { name: 'Disconnect' }),
    );
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }),
    );
    await settle();
    await person().keyboard('{Escape}');
    await settle();
    expect(view.getByRole('dialog')).toBeDefined();
    expect(asked).toEqual([['github', false]]);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmount();
  });
});

const OIDC_VIEW = {
  issuer: 'https://login.example.test/tenant-1',
  clientId: 'purlay-client',
  clientSecret: { set: true as const },
  name: 'Acme SSO',
};

const WITH_OIDC = anAnswer({
  settings: { ...anAnswer().settings, oidc: OIDC_VIEW },
  channels: { github: false, email: false, oidc: true, google: false },
});

describe('Settings → Server — single sign-on (D-200)', () => {
  const OIDC_REASONS_A_TRY_GIVES = [
    'secret-rejected',
    'client-unknown',
    'unreachable',
    'tls-failed',
    'unexpected-reply',
    'issuer-mismatch',
    'discovery-invalid',
  ] as const;

  const fill = async (scope: Scope, secret = 'shh-sso'): Promise<void> => {
    await person().type(scope.getByLabelText('Issuer'), ' https://login.example.test/tenant-1 ');
    await person().type(scope.getByLabelText('Client ID'), ' purlay-client ');
    await person().type(scope.getByLabelText('Client secret'), secret);
  };

  test('says nothing is connected, what that stops, and the address to register at the provider', async () => {
    const view = await render(aClient());
    const sso = card(view, 'Single sign-on');
    expect(sso.getByText('Not connected')).toBeDefined();
    expect(sso.getByText(en['settings.server.oidc.empty'])).toBeDefined();
    expect(sso.getByRole('button', { name: 'Connect single sign-on' })).toBeDefined();
    expect(view.getByRole('main').textContent).toContain('https://purlay.test/auth/callback/oidc');
    view.unmount();
  });

  test('shows the provider connected — its issuer and the client, never the secret', async () => {
    const view = await render(aClient({ settings: () => Promise.resolve(WITH_OIDC) }));
    const sso = card(view, 'Single sign-on');
    expect(sso.getByText('Connected')).toBeDefined();
    expect(sso.getByText('Issuer https://login.example.test/tenant-1')).toBeDefined();
    expect(sso.getByText('Client ID purlay-client')).toBeDefined();
    expect(sso.getByRole('button', { name: 'Replace provider' })).toBeDefined();
    expect(view.getByRole('main').textContent).not.toContain('shh');
    view.unmount();
  });

  test('the try is disabled until the issuer, the client and the secret are all there', async () => {
    const view = await render(aClient());
    const sso = card(view, 'Single sign-on');
    await person().click(sso.getByRole('button', { name: 'Connect single sign-on' }));
    const submit = sso.getByRole('button', { name: 'Try the connection and save' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await person().type(sso.getByLabelText('Issuer'), 'https://x.example.test');
    await person().type(sso.getByLabelText('Client ID'), 'id');
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    await person().type(sso.getByLabelText('Client secret'), 's');
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    view.unmount();
  });

  test('a provider that works is sent trimmed with its label, the form closes, and the card says it was saved', async () => {
    const sent: unknown[] = [];
    let saved = false;
    const view = await render(
      aClient({
        settings: () => Promise.resolve(saved ? WITH_OIDC : anAnswer()),
        oidc: (candidate) => {
          sent.push(candidate);
          saved = true;
          return Promise.resolve({ ok: true });
        },
      }),
    );
    const sso = card(view, 'Single sign-on');
    await person().click(sso.getByRole('button', { name: 'Connect single sign-on' }));
    await fill(sso);
    await person().type(sso.getByLabelText('Button label'), 'Acme SSO');
    await person().click(sso.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(sent).toEqual([
      {
        issuer: 'https://login.example.test/tenant-1',
        clientId: 'purlay-client',
        clientSecret: 'shh-sso',
        name: 'Acme SSO',
      },
    ]);
    expect(sso.getByText('Saved. Single sign-on uses this provider from now on.')).toBeDefined();
    // The secret goes one way: the form is closed and nothing on the page carries it.
    expect(sso.queryByLabelText('Client secret')).toBeNull();
    expect(view.getByRole('main').textContent).not.toContain('shh-sso');
    view.unmount();
  });

  test.each(OIDC_REASONS_A_TRY_GIVES)(
    'a try that fails for %s is said in words for a provider, keeps what was typed, and offers another try',
    async (reason) => {
      const failed: ProbeResult = { ok: false, reason, raw: '<b>the provider said no</b>' };
      const view = await render(aClient({ oidc: () => Promise.resolve(failed) }));
      const sso = card(view, 'Single sign-on');
      await person().click(sso.getByRole('button', { name: 'Connect single sign-on' }));
      await fill(sso);
      await person().click(sso.getByRole('button', { name: 'Try the connection and save' }));
      await settle();
      expect(sso.getByText(en[reasonWords(reason, 'oidc').what])).toBeDefined();
      // The provider's own words, as text: never read as markup.
      expect(sso.getByText('<b>the provider said no</b>')).toBeDefined();
      expect(sso.getByLabelText<HTMLInputElement>('Client secret').value).toBe('shh-sso');
      expect(sso.getByRole('button', { name: 'Try again' })).toBeDefined();
      // Never the GitHub words for a provider's failure.
      expect(sso.queryByText(/GitHub/)).toBeNull();
      view.unmount();
    },
  );

  test('a call that failed outright is told as a failure, and keeps the form', async () => {
    const view = await render(
      aClient({ oidc: () => Promise.reject(new SetupFailure(500, 'INTERNAL', 'no')) }),
    );
    const sso = card(view, 'Single sign-on');
    await person().click(sso.getByRole('button', { name: 'Connect single sign-on' }));
    await fill(sso);
    await person().click(sso.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(sso.getByRole('alert')).toBeDefined();
    expect(sso.getByLabelText<HTMLInputElement>('Client secret').value).toBe('shh-sso');
    view.unmount();
  });

  test('cancelling closes the form and forgets the try', async () => {
    const view = await render(aClient());
    const sso = card(view, 'Single sign-on');
    await person().click(sso.getByRole('button', { name: 'Connect single sign-on' }));
    await person().click(sso.getByRole('button', { name: 'Cancel' }));
    expect(sso.queryByLabelText('Issuer')).toBeNull();
    expect(sso.getByRole('button', { name: 'Connect single sign-on' })).toBeDefined();
    view.unmount();
  });

  test('disconnecting asks first, names what stops, and says the strong thing when it is the last way in', async () => {
    const asked: [string, boolean][] = [];
    const view = await render(
      aClient({
        settings: () => Promise.resolve(WITH_OIDC),
        disconnect: (channel, confirm) => {
          asked.push([channel, confirm]);
          return Promise.resolve();
        },
      }),
    );
    const sso = card(view, 'Single sign-on');
    await person().click(sso.getByRole('button', { name: 'Disconnect' }));
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.getByText(en['settings.server.oidc.disconnectBody'])).toBeDefined();
    expect(dialog.getByText(en['settings.server.lastWay'])).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Disconnect anyway' }));
    await settle();
    expect(asked).toEqual([['oidc', true]]);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(sso.getByText(en['settings.server.oidc.disconnected'])).toBeDefined();
    view.unmount();
  });

  test('with another way in serving, the question is the plain one, and it is sent unconfirmed', async () => {
    const asked: [string, boolean][] = [];
    const view = await render(
      aClient({
        settings: () =>
          Promise.resolve({
            ...WITH_OIDC,
            channels: { github: true, email: false, oidc: true, google: false },
          }),
        disconnect: (channel, confirm) => {
          asked.push([channel, confirm]);
          return Promise.resolve();
        },
      }),
    );
    await person().click(card(view, 'Single sign-on').getByRole('button', { name: 'Disconnect' }));
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.queryByText(en['settings.server.lastWay'])).toBeNull();
    await person().click(dialog.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(asked).toEqual([['oidc', false]]);
    view.unmount();
  });

  test('a secret the key could not open says so, with the form already open and a way to let it go', async () => {
    const view = await render(
      aClient({ settings: () => Promise.resolve(anAnswer({ needsReentry: ['oidc'] })) }),
    );
    const sso = card(view, 'Single sign-on');
    expect(sso.getByText(en['settings.server.reentry'])).toBeDefined();
    expect(sso.getByLabelText('Client secret')).toBeDefined();
    await person().click(sso.getByRole('button', { name: 'Disconnect' }));
    expect(
      within(view.getByRole('dialog')).getByText(en['settings.server.oidc.disconnectBody']),
    ).toBeDefined();
    view.unmount();
  });

  test('has no axe violations connected or not', async () => {
    const view = await render(aClient({ settings: () => Promise.resolve(WITH_OIDC) }));
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });
});

const GOOGLE_VIEW = {
  clientId: '1234-abc.apps.googleusercontent.com',
  clientSecret: { set: true as const },
};

const WITH_GOOGLE = anAnswer({
  settings: { ...anAnswer().settings, google: GOOGLE_VIEW },
  channels: { github: false, email: false, oidc: false, google: true },
});

describe('Settings → Server — Google (D-251)', () => {
  const GOOGLE_REASONS_A_TRY_GIVES = [
    'secret-rejected',
    'client-unknown',
    'unreachable',
    'tls-failed',
    'unexpected-reply',
  ] as const;

  const fill = async (scope: Scope, secret = 'shh-google'): Promise<void> => {
    await person().type(scope.getByLabelText('Client ID'), ' 1234-abc.apps.googleusercontent.com ');
    await person().type(scope.getByLabelText('Client secret'), secret);
  };

  test('says nothing is connected, and shows the address to register, which copies', async () => {
    const view = await render(aClient());
    const google = card(view, 'Sign in with Google');
    expect(google.getByText('Not connected')).toBeDefined();
    expect(google.getByText(en['settings.server.google.empty'])).toBeDefined();
    expect(google.getByRole('button', { name: 'Connect Google' })).toBeDefined();
    expect(google.getByText('https://purlay.test/auth/callback/google')).toBeDefined();
    await person().click(google.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(await navigator.clipboard.readText()).toBe('https://purlay.test/auth/callback/google');
    view.unmount();
  });

  test('a client that works is sent trimmed, both fields, the form closes, and the card says it is connected', async () => {
    const sent: unknown[] = [];
    let saved = false;
    const view = await render(
      aClient({
        settings: () => Promise.resolve(saved ? WITH_GOOGLE : anAnswer()),
        google: (candidate) => {
          sent.push(candidate);
          saved = true;
          return Promise.resolve({ ok: true });
        },
      }),
    );
    const google = card(view, 'Sign in with Google');
    await person().click(google.getByRole('button', { name: 'Connect Google' }));
    await fill(google);
    await person().click(google.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(sent).toEqual([
      { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'shh-google' },
    ]);
    expect(google.getByText('Connected')).toBeDefined();
    expect(google.getByText(en['settings.server.google.saved'])).toBeDefined();
    expect(google.queryByLabelText('Client secret')).toBeNull();
    expect(view.getByRole('main').textContent).not.toContain('shh-google');
    view.unmount();
  });

  test.each(GOOGLE_REASONS_A_TRY_GIVES)(
    'a try that fails for %s is said in words for Google, keeps what was typed, and offers another try',
    async (reason) => {
      const failed: ProbeResult = { ok: false, reason, raw: '<b>google said no</b>' };
      const view = await render(aClient({ google: () => Promise.resolve(failed) }));
      const google = card(view, 'Sign in with Google');
      await person().click(google.getByRole('button', { name: 'Connect Google' }));
      await fill(google);
      await person().click(google.getByRole('button', { name: 'Try the connection and save' }));
      await settle();
      expect(google.getByText(en[reasonWords(reason, 'google').what])).toBeDefined();
      expect(google.getByText('<b>google said no</b>')).toBeDefined();
      expect(google.getByLabelText<HTMLInputElement>('Client secret').value).toBe('shh-google');
      expect(google.getByRole('button', { name: 'Try again' })).toBeDefined();
      view.unmount();
    },
  );

  test('a call that failed outright is told as a failure, and keeps the form', async () => {
    const view = await render(
      aClient({ google: () => Promise.reject(new SetupFailure(500, 'INTERNAL', 'no')) }),
    );
    const google = card(view, 'Sign in with Google');
    await person().click(google.getByRole('button', { name: 'Connect Google' }));
    await fill(google);
    await person().click(google.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(google.getByRole('alert')).toBeDefined();
    expect(google.getByLabelText<HTMLInputElement>('Client secret').value).toBe('shh-google');
    view.unmount();
  });

  test('cancelling closes the form and forgets the try', async () => {
    const failed: ProbeResult = { ok: false, reason: 'secret-rejected', raw: 'no' };
    const view = await render(aClient({ google: () => Promise.resolve(failed) }));
    const google = card(view, 'Sign in with Google');
    await person().click(google.getByRole('button', { name: 'Connect Google' }));
    await fill(google);
    await person().click(google.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    await person().click(google.getByRole('button', { name: 'Cancel' }));
    expect(google.queryByLabelText('Client secret')).toBeNull();
    await person().click(google.getByRole('button', { name: 'Connect Google' }));
    expect(google.queryByText(en[reasonWords('secret-rejected', 'google').what])).toBeNull();
    view.unmount();
  });

  test('a secret the key could not open says so, with the form already open and a way to let it go', async () => {
    const view = await render(
      aClient({
        settings: () => Promise.resolve({ ...WITH_GOOGLE, needsReentry: ['google'] as const }),
      }),
    );
    const google = card(view, 'Sign in with Google');
    expect(google.getByText(en['settings.server.reentry'])).toBeDefined();
    expect(google.getByLabelText('Client secret')).toBeDefined();
    expect(google.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await person().click(google.getByRole('button', { name: 'Disconnect' }));
    expect(
      within(view.getByRole('dialog')).getByText(en['settings.server.google.disconnectTitle']),
    ).toBeDefined();
    view.unmount();
  });

  test('a refused client is said in both languages as the ID and the secret together: Google answers a wrong ID as it does a wrong secret', () => {
    const words = reasonWords('secret-rejected', 'google');
    expect(en[words.what]).toBe(
      'Google refused this client ID and secret. Check both against the Google Cloud console.',
    );
    expect(tr[words.what]).toBe(
      'Google bu istemci kimliğini ve gizli anahtarını reddetti. İkisini de Google Cloud konsolundakilerle karşılaştır.',
    );
    for (const key of [words.what, ...words.fix]) expect(tr[key]).not.toBe(en[key]);
  });

  test('a refused client outlines neither field: which of the two is wrong is not known', async () => {
    const failed: ProbeResult = { ok: false, reason: 'secret-rejected', raw: 'invalid_client' };
    const view = await render(aClient({ google: () => Promise.resolve(failed) }));
    const google = card(view, 'Sign in with Google');
    await person().click(google.getByRole('button', { name: 'Connect Google' }));
    await fill(google);
    await person().click(google.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(google.getByText(en[reasonWords('secret-rejected', 'google').what])).toBeDefined();
    expect(google.getByLabelText('Client ID').getAttribute('aria-invalid')).toBeNull();
    expect(google.getByLabelText('Client secret').getAttribute('aria-invalid')).toBeNull();
    view.unmount();
  });

  test('disconnecting as the last way in asks first and says the strong thing, then sends it confirmed', async () => {
    const asked: [string, boolean][] = [];
    const view = await render(
      aClient({
        settings: () => Promise.resolve(WITH_GOOGLE),
        disconnect: (channel, confirm) => {
          asked.push([channel, confirm]);
          return Promise.resolve();
        },
      }),
    );
    await person().click(
      card(view, 'Sign in with Google').getByRole('button', { name: 'Disconnect' }),
    );
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.getByText(en['settings.server.google.disconnectBody'])).toBeDefined();
    expect(dialog.getByText(en['settings.server.lastWay'])).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Disconnect anyway' }));
    await settle();
    expect(asked).toEqual([['google', true]]);
    expect(
      card(view, 'Sign in with Google').getByText(en['settings.server.google.disconnected']),
    ).toBeDefined();
    view.unmount();
  });

  test('Google counts as another way in for the others: disconnecting GitHub is the plain question', async () => {
    const view = await render(
      aClient({
        settings: () =>
          Promise.resolve({
            ...WITH_GOOGLE,
            settings: { ...WITH_GOOGLE.settings, github: CONNECTED.settings.github },
            channels: { github: true, email: false, oidc: false, google: true },
          }),
      }),
    );
    await person().click(
      card(view, 'Sign in with GitHub').getByRole('button', { name: 'Disconnect' }),
    );
    expect(within(view.getByRole('dialog')).queryByText(en['settings.server.lastWay'])).toBeNull();
    view.unmount();
  });

  test('the sign-in policy counts Google as a provider: passwords may be turned off with only Google', async () => {
    const asked: unknown[] = [];
    const view = await render(
      aClient({
        settings: () => Promise.resolve(WITH_GOOGLE),
        policy: (change) => {
          asked.push(change);
          return Promise.resolve();
        },
      }),
    );
    const signIn = card(view, 'How people sign in');
    expect(signIn.queryByText(en['settings.server.signIn.passwords.needsProvider'])).toBeNull();
    await person().click(signIn.getByRole('radio', { name: /^Off/ }));
    await settle();
    expect(asked).toEqual([{ passwordSignIn: false }]);
    view.unmount();
  });

  test('has no axe violations connected or not', async () => {
    const view = await render(aClient({ settings: () => Promise.resolve(WITH_GOOGLE) }));
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });
});

describe('Settings → Server → Accounts (D-233)', () => {
  const ADA: ServerAccount = {
    id: '00000000-0000-4000-8000-00000000a0a1',
    username: 'ada',
    displayName: 'Ada Lovelace',
    email: 'ada@example.test',
    isServerAdmin: false,
    suspendedAt: null,
  };
  const GRACE: ServerAccount = {
    ...ADA,
    id: '00000000-0000-4000-8000-00000000a0a2',
    username: 'grace',
    displayName: 'Grace Hopper',
    email: null,
    suspendedAt: '2026-10-30T08:00:00.000Z',
  };
  const ROOT: ServerAccount = {
    ...ADA,
    id: '00000000-0000-4000-8000-00000000a0a3',
    username: 'root',
    displayName: 'The administrator',
    isServerAdmin: true,
  };
  const rowOf = (view: View, name: string): Scope =>
    within(
      card(view, 'Accounts')
        .getAllByRole('listitem')
        .find((row) => row.textContent.includes(name)) ?? document.body,
    );

  test('lists each account with what it is: an administrator has no button, a suspended one says since when', async () => {
    const view = await render(aClient({ accounts: () => Promise.resolve([ADA, GRACE, ROOT]) }));
    expect(rowOf(view, 'Ada Lovelace').getByText('@ada · ada@example.test')).toBeDefined();
    expect(rowOf(view, 'Ada Lovelace').getByRole('button', { name: 'Suspend' })).toBeDefined();
    expect(rowOf(view, 'Grace Hopper').getByText(/^Suspended /)).toBeDefined();
    expect(
      rowOf(view, 'Grace Hopper').getByRole('button', { name: 'Lift suspension' }),
    ).toBeDefined();
    expect(rowOf(view, 'The administrator').getByText('Administers this server')).toBeDefined();
    expect(rowOf(view, 'The administrator').queryByRole('button')).toBeNull();
    await expectNoAxeViolations(
      card(view, 'Accounts').getByRole('list').parentElement ?? document.body,
    );
    view.unmount();
  });

  test('suspending asks once more, in words; Cancel suspends nobody, Suspend does and reads the list again', async () => {
    let accounts = [ADA];
    const suspended: string[] = [];
    const view = await render(
      aClient({
        accounts: () => Promise.resolve(accounts),
        suspend: (userId) => {
          suspended.push(userId);
          accounts = [{ ...ADA, suspendedAt: '2026-10-31T08:00:00.000Z' }];
          return Promise.resolve();
        },
      }),
    );
    await person().click(rowOf(view, 'Ada Lovelace').getByRole('button', { name: 'Suspend' }));
    expect(
      rowOf(view, 'Ada Lovelace').getByText(
        'Suspend Ada Lovelace? They are signed out on every device and cannot sign in until you lift it.',
      ),
    ).toBeDefined();
    await person().click(rowOf(view, 'Ada Lovelace').getByRole('button', { name: 'Cancel' }));
    expect(suspended).toEqual([]);
    await person().click(rowOf(view, 'Ada Lovelace').getByRole('button', { name: 'Suspend' }));
    await person().click(rowOf(view, 'Ada Lovelace').getByRole('button', { name: 'Suspend' }));
    await settle();
    expect(suspended).toEqual([ADA.id]);
    expect(
      rowOf(view, 'Ada Lovelace').getByRole('button', { name: 'Lift suspension' }),
    ).toBeDefined();
    view.unmount();
  });

  test('an account suspension cannot be cancelled or overlap another account action while pending', async () => {
    const view = await render(
      aClient({
        accounts: () => Promise.resolve([ADA, GRACE]),
        suspend: () => new Promise(() => undefined),
      }),
    );
    await person().click(rowOf(view, 'Ada Lovelace').getByRole('button', { name: 'Suspend' }));
    await person().click(rowOf(view, 'Ada Lovelace').getByRole('button', { name: 'Suspend' }));
    expect(
      rowOf(view, 'Ada Lovelace').getByRole<HTMLButtonElement>('button', { name: 'Cancel' })
        .disabled,
    ).toBe(true);
    expect(
      rowOf(view, 'Grace Hopper').getByRole<HTMLButtonElement>('button', {
        name: 'Lift suspension',
      }).disabled,
    ).toBe(true);
    view.unmount();
  });

  test('accounts left over from a previous search cannot be suspended while new results are pending', async () => {
    const view = await render(
      aClient({
        accounts: (words) => (words === '' ? Promise.resolve([ADA]) : new Promise(() => undefined)),
      }),
    );
    await person().type(card(view, 'Accounts').getByRole('searchbox'), 'grace');
    await settle();
    expect(
      rowOf(view, 'Ada Lovelace').getByRole<HTMLButtonElement>('button', { name: 'Suspend' })
        .disabled,
    ).toBe(true);
    view.unmount();
  });

  test('lifting asks nothing; a refusal is said on the card', async () => {
    const lifted: string[] = [];
    const view = await render(
      aClient({
        accounts: () => Promise.resolve([GRACE]),
        lift: (userId) => {
          lifted.push(userId);
          return Promise.reject(new SetupFailure(500, 'INTERNAL', 'no'));
        },
      }),
    );
    await person().click(
      rowOf(view, 'Grace Hopper').getByRole('button', { name: 'Lift suspension' }),
    );
    await settle();
    expect(lifted).toEqual([GRACE.id]);
    expect(card(view, 'Accounts').getAllByRole('alert').length).toBeGreaterThan(0);
    view.unmount();
  });

  test('a list that fails to load is said, with a Retry that reads it again', async () => {
    let asks = 0;
    const view = await render(
      aClient({
        accounts: () => {
          asks += 1;
          return asks === 1
            ? Promise.reject(new SetupFailure(500, 'INTERNAL', 'no'))
            : Promise.resolve([ADA]);
        },
      }),
    );
    expect(card(view, 'Accounts').getAllByRole('alert').length).toBeGreaterThan(0);
    await person().click(card(view, 'Accounts').getByRole('button', { name: 'Retry' }));
    await settle();
    expect(rowOf(view, 'Ada Lovelace').getByRole('button', { name: 'Suspend' })).toBeDefined();
    view.unmount();
  });

  test('what is typed is what is searched for; nothing found is said', async () => {
    const asked: string[] = [];
    const view = await render(
      aClient({
        accounts: (words) => {
          asked.push(words);
          return Promise.resolve(words === '' ? [ADA] : []);
        },
      }),
    );
    await person().type(
      card(view, 'Accounts').getByLabelText('Find by name, username or address'),
      'zzz',
    );
    await settle();
    expect(asked[0]).toBe('');
    expect(asked.at(-1)).toBe('zzz');
    expect(card(view, 'Accounts').getByText('No account matches.')).toBeDefined();
    view.unmount();
  });
});

describe('Settings → Server — the GitHub App (D-246)', () => {
  const KEY = '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----';

  const fill = async (github: Scope): Promise<void> => {
    await person().click(github.getByRole('button', { name: 'Connect the GitHub App' }));
    await person().type(github.getByLabelText('App ID'), '4242');
    await person().type(github.getByLabelText('App slug'), 'purlay-issues');
    await person().type(github.getByLabelText('Client ID'), 'Iv23.x');
    await person().type(github.getByLabelText('Client secret'), 'secret');
    await person().type(github.getByLabelText('Private key'), 'k');
    await person().type(github.getByLabelText('Webhook secret'), 'hook');
  };

  test('says nothing is offered until it is connected, shows the two addresses to paste, and passes axe', async () => {
    const view = await render(aClient());
    const app = card(view, 'GitHub App for issues');
    expect(app.getByText('Not connected')).toBeDefined();
    expect(app.getByText(en['settings.server.githubApp.empty'])).toBeDefined();
    const page = view.getByRole('main').textContent;
    expect(page).toContain('https://purlay.test/api/github-app/callback');
    expect(page).toContain('https://purlay.test/api/webhooks/github-app');
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test.each(['key-rejected', 'app-mismatch', 'secret-rejected'] as const)(
    'a try that fails for %s is said, keeps what was typed and keeps nothing',
    async (reason) => {
      const failed: ProbeResult = { ok: false, reason, raw: 'GitHub said no' };
      const view = await render(aClient({ githubApp: () => Promise.resolve(failed) }));
      const app = card(view, 'GitHub App for issues');
      await fill(app);
      await person().click(app.getByRole('button', { name: 'Try the connection and save' }));
      await settle();
      expect(app.getByText(en[REASONS[reason].what])).toBeDefined();
      expect(app.getByLabelText('App ID')).toHaveProperty('value', '4242');
      view.unmount();
    },
  );

  test('a good try saves, sends the key as typed once, and the secrets are emptied', async () => {
    const sent: unknown[] = [];
    const view = await render(
      aClient({
        githubApp: (candidate) => {
          sent.push(candidate);
          return Promise.resolve({ ok: true });
        },
      }),
    );
    const app = card(view, 'GitHub App for issues');
    await fill(app);
    await person().click(app.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(sent).toEqual([
      {
        appId: 4242,
        slug: 'purlay-issues',
        clientId: 'Iv23.x',
        clientSecret: 'secret',
        privateKey: 'k',
        webhookSecret: 'hook',
      },
    ]);
    expect(app.getByText(en['settings.server.githubApp.saved'])).toBeDefined();
    expect(KEY).toContain('PRIVATE KEY');
    view.unmount();
  });

  test('a form opened can be closed again, and a refused change is said in the card, keeping the form', async () => {
    const view = await render(
      aClient({ githubApp: () => Promise.reject(new SetupFailure(500, 'INTERNAL', 'no')) }),
    );
    const app = card(view, 'GitHub App for issues');
    await fill(app);
    await person().click(app.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(app.getByRole('alert')).toBeDefined();
    expect(app.getByLabelText('App ID')).toHaveProperty('value', '4242');
    await person().click(app.getByRole('button', { name: 'Cancel' }));
    expect(app.queryByLabelText('App ID')).toBeNull();
    expect(app.getByRole('button', { name: 'Connect the GitHub App' })).toBeDefined();
    view.unmount();
  });

  test('a secret the key could not open says to enter it again, and lets the App go from the form', async () => {
    let disconnected = '';
    const lost = anAnswer({ needsReentry: ['githubApp'] });
    const view = await render(
      aClient({
        settings: () => Promise.resolve(lost),
        disconnect: (channel) => {
          disconnected = channel;
          return Promise.resolve();
        },
      }),
    );
    const app = card(view, 'GitHub App for issues');
    expect(app.getByText(en['settings.server.reentry'])).toBeDefined();
    expect(app.getByLabelText('App ID')).toBeDefined();
    expect(app.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await person().click(app.getByRole('button', { name: 'Disconnect' }));
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }),
    );
    await settle();
    expect(disconnected).toBe('github-app');
    view.unmount();
  });

  test('the question before letting the App go is dismissed with Escape, and nothing is disconnected', async () => {
    let disconnected = false;
    const connected = anAnswer({
      settings: {
        ...anAnswer().settings,
        githubApp: {
          appId: 4242,
          slug: 'purlay-issues',
          clientId: 'Iv23.x',
          clientSecret: { set: true },
          privateKey: { set: true },
          webhookSecret: { set: true },
        },
      },
    });
    const view = await render(
      aClient({
        settings: () => Promise.resolve(connected),
        disconnect: () => {
          disconnected = true;
          return Promise.resolve();
        },
      }),
    );
    const app = card(view, 'GitHub App for issues');
    await person().click(app.getByRole('button', { name: 'Disconnect' }));
    expect(view.getByRole('dialog')).toBeDefined();
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(disconnected).toBe(false);
    view.unmount();
  });

  test('a disconnect that fails is said in the question, which stays open', async () => {
    const connected = anAnswer({
      settings: {
        ...anAnswer().settings,
        githubApp: {
          appId: 4242,
          slug: 'purlay-issues',
          clientId: 'Iv23.x',
          clientSecret: { set: true },
          privateKey: { set: true },
          webhookSecret: { set: true },
        },
      },
    });
    const view = await render(
      aClient({
        settings: () => Promise.resolve(connected),
        disconnect: () => Promise.reject(new SetupFailure(500, 'INTERNAL', 'no')),
      }),
    );
    const app = card(view, 'GitHub App for issues');
    await person().click(app.getByRole('button', { name: 'Disconnect' }));
    const dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(within(view.getByRole('dialog')).getByRole('alert')).toBeDefined();
    await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmount();
  });

  test('a card that is connected can be replaced: its identity is kept in the form, its secrets are not', async () => {
    const connected = anAnswer({
      settings: {
        ...anAnswer().settings,
        githubApp: {
          appId: 4242,
          slug: 'purlay-issues',
          clientId: 'Iv23.x',
          clientSecret: { set: true },
          privateKey: { set: true },
          webhookSecret: { set: true },
        },
      },
    });
    const view = await render(aClient({ settings: () => Promise.resolve(connected) }));
    const app = card(view, 'GitHub App for issues');
    await person().click(app.getByRole('button', { name: 'Replace credentials' }));
    expect(app.getByLabelText('App ID')).toHaveProperty('value', '4242');
    expect(app.getByLabelText('Client secret')).toHaveProperty('value', '');
    expect(app.getByLabelText('Private key')).toHaveProperty('value', '');
    view.unmount();
  });

  test('connected, it shows who it is and no secret; disconnecting asks once and says what stays', async () => {
    const connected = anAnswer({
      settings: {
        ...anAnswer().settings,
        githubApp: {
          appId: 4242,
          slug: 'purlay-issues',
          clientId: 'Iv23.x',
          clientSecret: { set: true },
          privateKey: { set: true },
          webhookSecret: { set: true },
        },
      },
    });
    let disconnected = '';
    const view = await render(
      aClient({
        settings: () => Promise.resolve(connected),
        disconnect: (channel) => {
          disconnected = channel;
          return Promise.resolve();
        },
      }),
    );
    const app = card(view, 'GitHub App for issues');
    expect(app.getByText('purlay-issues · App 4242')).toBeDefined();
    await person().click(app.getByRole('button', { name: 'Disconnect' }));
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.getByText(en['settings.server.githubApp.disconnectBody'])).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Disconnect' }));
    await settle();
    expect(disconnected).toBe('github-app');
    view.unmount();
  });
});

describe('Settings → Server pending policies', () => {
  test('a pending sign-up policy holds the radio group until its request finishes', async () => {
    const view = await render(aClient({ policy: () => new Promise(() => undefined) }));
    const group = within(await view.findByRole('radiogroup', { name: 'Sign-up policy' }));
    const radios = group.getAllByRole<HTMLInputElement>('radio');
    const unselected = radios.find((radio) => !radio.checked);
    if (unselected === undefined) throw new Error('no alternative policy');
    await person().click(unselected);
    expect(radios.every((radio) => radio.disabled)).toBe(true);
    view.unmount();
  });

  test('a pending sign-in rule holds both related groups', async () => {
    const view = await render(aClient({ policy: () => new Promise(() => undefined) }));
    await person().click(card(view, 'How people sign in').getByRole('radio', { name: /Required/ }));
    const radios = card(view, 'How people sign in').getAllByRole<HTMLInputElement>('radio');
    expect(radios.every((radio) => radio.disabled)).toBe(true);
    view.unmount();
  });

  test('session lifetime choices cannot overlap while saving', async () => {
    const view = await render(aClient({ policy: () => new Promise(() => undefined) }));
    const idle = card(view, 'How long a session lasts').getByLabelText<HTMLSelectElement>(
      'Sign out when unused for',
    );
    await person().selectOptions(idle, '24');
    expect(idle.disabled).toBe(true);
    expect(
      card(view, 'How long a session lasts').getByLabelText<HTMLSelectElement>(
        'Sign in again after',
      ).disabled,
    ).toBe(true);
    view.unmount();
  });

  test('a saved policy remains selected when refreshing fails and a visible Retry recovers', async () => {
    let failed = false;
    let answer = anAnswer();
    const view = await render(
      aClient({
        settings: () =>
          failed
            ? Promise.reject(new SetupFailure(503, 'NETWORK', 'offline'))
            : Promise.resolve(answer),
        policy: (change) => {
          answer = { ...answer, settings: { ...answer.settings, ...change } };
          failed = true;
          return Promise.resolve();
        },
      }),
    );
    const group = within(await view.findByRole('radiogroup', { name: 'Sign-up policy' }));
    const unselected = group
      .getAllByRole<HTMLInputElement>('radio')
      .find((radio) => !radio.checked);
    if (unselected === undefined) throw new Error('no alternative policy');
    await person().click(unselected);
    await settle();
    expect(unselected.checked).toBe(true);
    expect(main(view).queryByText('Nothing was changed. Try again.') === null).toBe(true);
    expect(main(view).getByRole('button', { name: 'Retry' })).toBeDefined();
    failed = false;
    await person().click(main(view).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(main(view).queryByRole('button', { name: 'Retry' })).toBeNull();
    view.unmount();
  });
});

describe('Settings → Server confirmed changes and dismissed forms', () => {
  test('replacement starts with the latest public credentials after another settings refresh', async () => {
    const view = await render(aClient({ settings: () => Promise.resolve(CONNECTED) }));
    act(() => {
      view.world.client.setQueryData(SERVER_SETTINGS_KEY, {
        ...CONNECTED,
        settings: {
          ...CONNECTED.settings,
          github: { clientId: 'latest-client', clientSecret: { set: true } },
        },
      });
    });
    await settle();
    const section = card(view, 'Sign in with GitHub');
    await person().click(section.getByRole('button', { name: 'Replace credentials' }));
    expect(section.getByLabelText<HTMLInputElement>('Client ID').value).toBe('latest-client');
    view.unmount();
  });

  test('workspace creators follow refreshed settings until there is an unsaved edit', async () => {
    const view = await render(aClient());
    const update = async (kind: 'first' | 'anyone'): Promise<void> => {
      act(() => {
        view.world.client.setQueryData(SERVER_SETTINGS_KEY, {
          ...anAnswer(),
          settings: { ...anAnswer().settings, workspaceCreators: { kind } },
        });
      });
      await settle();
    };
    await update('anyone');
    const section = card(view, 'Who can create workspaces');
    expect(section.getByRole<HTMLInputElement>('radio', { name: /Anyone/ }).checked).toBe(true);
    await person().click(section.getByRole('radio', { name: /Only these GitHub accounts/ }));
    await person().type(section.getByLabelText('GitHub logins'), 'ada');
    await update('first');
    expect(section.getByLabelText<HTMLInputElement>('GitHub logins').value).toBe('ada');
    view.unmount();
  });

  test('repairing an unreadable credential clears its reentry warning even if the refresh fails', async () => {
    let saved = false;
    const view = await render(
      aClient({
        settings: () =>
          saved
            ? Promise.reject(new SetupFailure(503, 'NETWORK', 'offline'))
            : Promise.resolve(anAnswer({ needsReentry: ['github'] })),
        github: () => {
          saved = true;
          return Promise.resolve({ ok: true });
        },
      }),
    );
    const section = card(view, 'Sign in with GitHub');
    await person().type(section.getByLabelText('Client ID'), 'new-client');
    await person().type(section.getByLabelText('Client secret'), 'new-secret');
    await person().click(section.getByRole('button', { name: 'Try the connection and save' }));
    await settle();
    expect(section.queryByText(en['settings.server.reentry']) === null).toBe(true);
    expect(section.queryByLabelText('Client secret') === null).toBe(true);
    view.unmount();
  });

  test.each([
    ['Sign in with GitHub', 'Connect GitHub', ['Client secret']],
    ['Sign in with Google', 'Connect Google', ['Client secret']],
    ['Single sign-on', 'Connect single sign-on', ['Client secret']],
    ['E-mail', 'Connect a mail server', ['SMTP password']],
    [
      'GitHub App for issues',
      'Connect the GitHub App',
      ['Client secret', 'Private key', 'Webhook secret'],
    ],
  ] as const)('cancelling %s forgets its credentials', async (title, connect, secrets) => {
    const view = await render(aClient());
    const section = card(view, title);
    await person().click(section.getByRole('button', { name: connect }));
    for (const label of secrets)
      await person().type(section.getByLabelText(label), 'do-not-retain');
    await person().click(section.getByRole('button', { name: 'Cancel' }));
    await person().click(section.getByRole('button', { name: connect }));
    for (const label of secrets) {
      expect(section.getByLabelText<HTMLInputElement | HTMLTextAreaElement>(label).value).toBe('');
    }
    view.unmount();
  });

  test('a cancelled last-channel refusal is weighed again when the dialog is reopened', async () => {
    const confirmations: boolean[] = [];
    const view = await render(
      aClient({
        settings: () => Promise.resolve(CONNECTED),
        disconnect: (_channel, confirm) => {
          confirmations.push(confirm);
          return Promise.reject(
            new SetupFailure(409, 'SERVER_CHANGE_REFUSED', 'no', null, {}, null, 'last-channel'),
          );
        },
      }),
    );
    const email = card(view, 'E-mail');
    await person().click(email.getByRole('button', { name: 'Disconnect' }));
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }),
    );
    await settle();
    expect(
      within(view.getByRole('dialog')).queryByRole('button', { name: 'Disconnect anyway' }) !==
        null,
    ).toBe(true);
    await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await person().click(email.getByRole('button', { name: 'Disconnect' }));
    expect(
      within(view.getByRole('dialog')).queryByRole('button', { name: 'Disconnect anyway' }) ===
        null,
    ).toBe(true);
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }),
    );
    expect(confirmations).toEqual([false, false]);
    view.unmount();
  });

  test.each(['github', 'google', 'oidc', 'smtp', 'githubApp'] as const)(
    'an accepted %s connection survives a failed refresh without caching secrets',
    async (kind) => {
      let saved = false;
      const accepted = (): Promise<ProbeResult> => {
        saved = true;
        return Promise.resolve({ ok: true });
      };
      const view = await render(
        aClient({
          settings: () =>
            saved
              ? Promise.reject(new SetupFailure(503, 'NETWORK', 'offline'))
              : Promise.resolve(anAnswer()),
          [kind]: accepted,
        }),
      );
      const title = {
        github: 'Sign in with GitHub',
        google: 'Sign in with Google',
        oidc: 'Single sign-on',
        smtp: 'E-mail',
        githubApp: 'GitHub App for issues',
      }[kind];
      const section = card(view, title);
      const connect = {
        github: 'Connect GitHub',
        google: 'Connect Google',
        oidc: 'Connect single sign-on',
        smtp: 'Connect a mail server',
        githubApp: 'Connect the GitHub App',
      }[kind];
      await person().click(section.getByRole('button', { name: connect }));
      if (kind === 'smtp')
        await person().click(section.getByRole('button', { name: 'Use an SMTP URL' }));
      const fields =
        kind === 'smtp'
          ? {
              'Mail server': 'smtps://alice:never-cache-this@mail.example.test:465',
              Sender: 'mail@example.test',
            }
          : {
              'Client ID': 'client-id',
              'Client secret': 'never-cache-this',
              ...(kind === 'oidc' ? { Issuer: 'https://id.example.test' } : {}),
              ...(kind === 'githubApp'
                ? {
                    'App ID': '123',
                    'App slug': 'our-app',
                    'Private key': 'never-cache-this',
                    'Webhook secret': 'never-cache-this',
                  }
                : {}),
            };
      for (const [label, value] of Object.entries(fields))
        await person().type(section.getByLabelText(label), value);
      await person().click(
        section.getByRole('button', {
          name: kind === 'smtp' ? 'Send a test message and save' : 'Try the connection and save',
        }),
      );
      await settle();
      expect(section.queryByText('Connected') !== null).toBe(true);
      const held = view.world.client.getQueryData<ServerSettingsAnswer>(SERVER_SETTINGS_KEY);
      expect(held?.settings[kind] !== null).toBe(true);
      expect(JSON.stringify(held).includes('never-cache-this')).toBe(false);
      if (kind === 'smtp')
        expect(held?.settings.smtp?.address.host).toBe('smtps://mail.example.test:465');
      expect(main(view).queryByRole('button', { name: 'Retry' }) !== null).toBe(true);
      view.unmount();
    },
  );

  test('an accepted disconnect remains disconnected when refreshing fails', async () => {
    let saved = false;
    const view = await render(
      aClient({
        settings: () =>
          saved
            ? Promise.reject(new SetupFailure(503, 'NETWORK', 'offline'))
            : Promise.resolve(CONNECTED),
        disconnect: () => {
          saved = true;
          return Promise.resolve();
        },
      }),
    );
    const github = card(view, 'Sign in with GitHub');
    await person().click(github.getByRole('button', { name: 'Disconnect' }));
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }),
    );
    await settle();
    expect(github.queryByText('Not connected') !== null).toBe(true);
    expect(
      view.world.client.getQueryData<ServerSettingsAnswer>(SERVER_SETTINGS_KEY)?.channels.github,
    ).toBe(false);
    view.unmount();
  });

  test('accepted workspace creators do not offer saving the same change again after a failed refresh', async () => {
    let saved = false;
    const view = await render(
      aClient({
        settings: () =>
          saved
            ? Promise.reject(new SetupFailure(503, 'NETWORK', 'offline'))
            : Promise.resolve(anAnswer()),
        creators: () => {
          saved = true;
          return Promise.resolve();
        },
      }),
    );
    const section = card(view, 'Who can create workspaces');
    await person().click(section.getByRole('radio', { name: /Anyone/ }));
    await person().click(section.getByRole('button', { name: 'Save' }));
    await settle();
    expect(section.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    view.unmount();
  });

  test('an account read failure explains that it could not load the list', async () => {
    const view = await render(
      aClient({ accounts: () => Promise.reject(new SetupFailure(503, 'NETWORK', 'offline')) }),
    );
    const section = card(view, 'Accounts');
    expect(section.queryByText('Nothing was changed. Try again.') === null).toBe(true);
    expect(
      section.queryByText('Could not read the accounts. Retry to get the current list.') !== null,
    ).toBe(true);
    view.unmount();
  });
});
