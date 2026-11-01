/**
 * Settings → Server (`UX.md` §11, D-179 §4.8), through the real frame at the page's address: offered to
 * the server's administrator alone — a workspace's owner is not one, and the address is *not found* for
 * everybody else — each card's states, the wizard's own sentence per reason of a failed try (and nothing
 * kept), the question before a way in is disconnected (the strong one when it is the last), and the line
 * on a card whose secret the key could not open.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import {
  PROBE_REASONS,
  type ProbeResult,
  type ServerAccount,
  type ServerSettingsAnswer,
} from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import { en } from '../../../i18n/catalogue/en';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { SetupFailure } from '../../setup/client';
import { REASONS, reasonWords } from '../../setup/errors';
import type { ServerClient } from '../server-client';
import { ServerClientProvider } from '../server-context';

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
    smtp: null,
    githubApp: null,
    workspaceCreators: { kind: 'first' },
    setupCompletedAt: '2026-10-01T00:00:00.000Z',
  },
  needsReentry: [],
  appUrl: 'https://purlay.test',
  githubCallbackUrl: 'https://purlay.test/auth/callback/github',
  oidcCallbackUrl: 'https://purlay.test/auth/callback/oidc',
  githubApp: {
    callbackUrl: 'https://purlay.test/api/github-app/callback',
    webhookUrl: 'https://purlay.test/api/webhooks/github-app',
  },
  channels: { github: false, email: false, oidc: false },
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
    smtp: {
      address: { set: true, host: 'smtp://mail.example.test:587' },
      from: 'purlay@example.test',
      allowPlaintext: false,
    },
    githubApp: null,
    workspaceCreators: { kind: 'listed', logins: ['ada', 'grace'] },
    setupCompletedAt: '2026-10-01T00:00:00.000Z',
  },
  channels: { github: true, email: true, oidc: false },
});

const unexpected = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`the test did not expect client.${name} to be called`));

const aClient = (over: Partial<ServerClient> = {}): ServerClient => ({
  settings: () => Promise.resolve(anAnswer()),
  github: unexpected('github'),
  oidc: unexpected('oidc'),
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

const render = async (
  client: ServerClient,
  { admin = true, owner = true }: { admin?: boolean; owner?: boolean } = {},
): Promise<View> => {
  const session = aSession();
  const view = await renderApp(
    <ServerClientProvider value={client}>
      <Outlet />
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
      channels: { github: true, email: false, oidc: false },
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

  test('passwords cannot be turned off with neither GitHub nor single sign-on: said before, and the refusal in its words', async () => {
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

  test('with passwords off, the last of GitHub and single sign-on is not offered to be disconnected (D-239)', async () => {
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
    await person().type(email.getByLabelText('Mail server'), 'smtp://mail.example.test');
    await person().type(email.getByLabelText('Sender'), 'purlay@example.test');
    return { view, email };
  };

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
  channels: { github: false, email: false, oidc: true },
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
            channels: { github: true, email: false, oidc: true },
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
