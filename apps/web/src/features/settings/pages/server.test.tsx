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
import { PROBE_REASONS, type ProbeResult, type ServerSettingsAnswer } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import { en } from '../../../i18n/catalogue/en';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { SetupFailure } from '../../setup/client';
import { REASONS } from '../../setup/errors';
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
    github: null,
    smtp: null,
    workspaceCreators: { kind: 'first' },
    setupCompletedAt: '2026-10-01T00:00:00.000Z',
  },
  needsReentry: [],
  appUrl: 'https://purlay.test',
  githubCallbackUrl: 'https://purlay.test/auth/callback/github',
  channels: { github: false, email: false },
  adminEmail: 'admin@example.test',
  ...over,
});

const CONNECTED = anAnswer({
  settings: {
    signUp: 'open',
    github: { clientId: 'Iv1.abc123', clientSecret: { set: true } },
    smtp: {
      address: { set: true, host: 'smtp://mail.example.test:587' },
      from: 'purlay@example.test',
      allowPlaintext: false,
    },
    workspaceCreators: { kind: 'listed', logins: ['ada', 'grace'] },
    setupCompletedAt: '2026-10-01T00:00:00.000Z',
  },
  channels: { github: true, email: true },
});

const unexpected = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`the test did not expect client.${name} to be called`));

const aClient = (over: Partial<ServerClient> = {}): ServerClient => ({
  settings: () => Promise.resolve(anAnswer()),
  github: unexpected('github'),
  smtp: unexpected('smtp'),
  disconnect: unexpected('disconnect'),
  policy: unexpected('policy'),
  creators: unexpected('creators'),
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
      channels: { github: true, email: false },
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
    const asked: string[] = [];
    const view = await render(
      aClient({
        policy: (signUp) => {
          asked.push(signUp);
          return Promise.resolve();
        },
      }),
    );
    const policy = card(view, 'Who can create an account');
    expect(policy.getByText(en['settings.server.policy.open.body'])).toBeDefined();
    await person().click(policy.getByRole('radio', { name: /Anyone/ }));
    await settle();
    expect(asked).toEqual(['open']);
    expect(policy.getByText('Saved. This applies from the next sign-up.')).toBeDefined();
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
