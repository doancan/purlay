/**
 * Sessions & account (D-11, D-139 §5, D-146), through the real frame at the page's address: signing
 * out here, signing out everywhere — which asks first — and erasing the account, which asks for the
 * username.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { expectFocusOn } from '../../../testing/focus';
import { installDom } from '../../../testing/dom';
import { aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';
import { connectGitHubHref } from '@purlay/types';
import { href } from '../../../router/routes';
import { leaveFor } from './account';

installDom();

/** What `within` answers: the queries, bound to one part of the page. */
type Scope = BoundFunctions<typeof queries>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

type View = Awaited<ReturnType<typeof renderApp>>;

/** The Sessions & account page, loaded: its chunk is lazy, so the heading is waited for. */
const open = async (api: Partial<Api> = {}): Promise<View> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    { path: '/w/acme/settings/account', api: aSignedInApi(api) },
  );
  await settle();
  await view.findByRole('heading', { level: 1, name: 'Sessions & account' });
  return view;
};

const main = (view: View): Scope => within(view.getByRole('main'));

const here = (view: View): string => view.world.history.stack.at(-1) ?? '';

describe('the page', () => {
  test('is everyone’s: a member opens it too, and it passes the accessibility audit', async () => {
    const session = aSession();
    const view = await open({
      me: () =>
        Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role: 'member' as const })),
        }),
    });
    expect(
      view.getByRole('link', { name: 'Sessions & account' }).getAttribute('aria-current'),
    ).toBe('page');
    // On a phone the danger zone's fill-less buttons line their words up with the words above.
    for (const name of ['Leave workspace…', 'Erase my account…']) {
      expect(main(view).getByRole('button', { name }).className.split(' ')).toContain(
        'max-narrow:-ml-3',
      );
    }
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test('signs out here without asking, and goes to sign-in without a way Back', async () => {
    let signedOut = false;
    const view = await open({
      me: () =>
        signedOut
          ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no'))
          : Promise.resolve(aSession()),
      signOut: () => {
        signedOut = true;
        return Promise.resolve();
      },
    });
    await person().click(main(view).getByRole('button', { name: 'Sign out' }));
    await settle();
    expect(signedOut).toBe(true);
    expect(view.world.history.stack).toEqual(['/sign-in']);
    view.unmount();
  });
});

describe('signing out everywhere', () => {
  const counted = (): { asked: string[]; api: Partial<Api> } => {
    const asked: string[] = [];
    return {
      asked,
      api: {
        // Signed out, the session is gone: the sign-in screen does not bounce back.
        me: () =>
          asked.length > 0
            ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no'))
            : Promise.resolve(aSession()),
        signOut: (): Promise<void> => {
          asked.push('here');
          return Promise.resolve();
        },
        signOutEverywhere: (): Promise<void> => {
          asked.push('everywhere');
          return Promise.resolve();
        },
      },
    };
  };

  test('asks first, and Cancel signs nobody out', async () => {
    const { asked, api } = counted();
    const view = await open(api);
    await person().click(main(view).getByRole('button', { name: 'Sign out everywhere…' }));
    const dialog = view.getByRole('dialog', { name: 'Sign out everywhere?' });
    await expectNoAxeViolations(dialog);
    await person().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(asked).toEqual([]);
    expect(here(view)).not.toBe('/sign-in');
    view.unmount();
  });

  test('Cancel gives focus back to the button that opened it', async () => {
    const view = await open(counted().api);
    const trigger = main(view).getByRole('button', { name: 'Sign out everywhere…' });
    act(() => {
      trigger.focus();
    });
    await person().keyboard('{Enter}');
    await settle();
    const dialog = view.getByRole('dialog', { name: 'Sign out everywhere?' });
    await person().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await settle();
    expectFocusOn(trigger);
    view.unmount();
  });

  test('confirmed, ends every session and goes to sign-in', async () => {
    const { asked, api } = counted();
    const view = await open(api);
    await person().click(main(view).getByRole('button', { name: 'Sign out everywhere…' }));
    const dialog = view.getByRole('dialog', { name: 'Sign out everywhere?' });
    await person().click(within(dialog).getByRole('button', { name: 'Sign out everywhere' }));
    await settle();
    expect(asked).toEqual(['everywhere']);
    expect(view.world.history.stack).toEqual(['/sign-in']);
    view.unmount();
  });

  test('refused, says so and stays', async () => {
    const view = await open({
      signOutEverywhere: () => Promise.reject(new ApiError(500, 'INTERNAL', 'x')),
    });
    await person().click(main(view).getByRole('button', { name: 'Sign out everywhere…' }));
    await person().click(
      within(view.getByRole('dialog')).getByRole('button', { name: 'Sign out everywhere' }),
    );
    expect(await view.findByText(/^Couldn't sign you out\./)).toBeDefined();
    expect(here(view)).not.toBe('/sign-in');
    view.unmount();
  });
});

describe('erasing the account (D-139 §5)', () => {
  const erasing = async (api: Partial<Api>): Promise<{ view: View; dialog: HTMLElement }> => {
    const view = await open(api);
    await person().click(main(view).getByRole('button', { name: 'Erase my account…' }));
    return { view, dialog: view.getByRole('dialog', { name: 'Erase your account' }) };
  };
  const field = (dialog: HTMLElement): HTMLElement =>
    within(dialog).getByLabelText('Type your username, dogancan, to confirm');

  test('says what goes and what stays, and does nothing until the username is typed', async () => {
    const asked: string[] = [];
    const { view, dialog } = await erasing({
      // Signed out once erased, as the cookie the answer clears makes it.
      me: () =>
        asked.length > 0
          ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no'))
          : Promise.resolve(aSession()),
      eraseAccount: (confirm) => {
        asked.push(confirm);
        return Promise.resolve();
      },
    });
    expect(dialog.textContent).toContain('What you wrote stays for your team');
    const erase = within(dialog).getByRole('button', { name: 'Erase my account' });
    expect(erase).toHaveProperty('disabled', true);
    await person().type(field(dialog), 'dogancaN');
    expect(erase).toHaveProperty('disabled', true);
    await person().clear(field(dialog));
    await person().type(field(dialog), 'dogancan');
    await expectNoAxeViolations(dialog);
    await person().click(erase);
    await settle();
    expect(asked).toEqual(['dogancan']);
    expect(here(view)).toBe('/sign-in?reason=erased');
  });

  test('Enter with another name is told so under the field; Cancel closes and forgets what was typed', async () => {
    const { view, dialog } = await erasing({
      eraseAccount: () => {
        throw new Error('nothing should be erased');
      },
    });
    await person().type(field(dialog), 'somebody{Enter}');
    expect(field(dialog).getAttribute('aria-invalid')).toBe('true');
    await person().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    await person().click(main(view).getByRole('button', { name: 'Erase my account…' }));
    const again = view.getByRole('dialog', { name: 'Erase your account' });
    expect((field(again) as HTMLInputElement).value).toBe('');
  });

  test('a session too old is told to sign in again, with the way to it', async () => {
    const signedOut: string[] = [];
    const { view, dialog } = await erasing({
      eraseAccount: () => Promise.reject(new ApiError(403, 'REAUTHENTICATION_REQUIRED', 'old')),
      signOut: () => {
        signedOut.push('here');
        return Promise.resolve();
      },
      me: () =>
        signedOut.length > 0
          ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no'))
          : Promise.resolve(aSession()),
    });
    await person().type(field(dialog), 'dogancan');
    await person().click(within(dialog).getByRole('button', { name: 'Erase my account' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain('sign in again first');
    await person().click(within(dialog).getByRole('button', { name: 'Sign out to sign in again' }));
    await settle();
    expect(signedOut).toEqual(['here']);
    expect(here(view)).toBe('/sign-in');
  });

  test('the last owner is told which workspaces to hand over, by name', async () => {
    const { dialog } = await erasing({
      eraseAccount: () =>
        Promise.reject(
          new ApiError(409, 'LAST_OWNER', 'hand over', {}, undefined, [
            aSession().memberships[0]?.workspace.id ?? '',
          ]),
        ),
    });
    await person().type(field(dialog), 'dogancan');
    await person().click(within(dialog).getByRole('button', { name: 'Erase my account' }));
    await settle();
    const name = aSession().memberships[0]?.workspace.name ?? '';
    expect(within(dialog).getByRole('alert').textContent).toBe(
      `Hand these workspaces to another owner first: ${name}.`,
    );
  });

  test('a username the server does not take is said under the field; any other failure above it', async () => {
    const failures = [
      new ApiError(400, 'VALIDATION_FAILED', 'no', { confirm: 'is not' }),
      new ApiError(0, 'NETWORK', 'offline'),
    ];
    const { dialog } = await erasing({
      eraseAccount: () => Promise.reject(failures.shift() ?? new Error('no more')),
    });
    await person().type(field(dialog), 'dogancan');
    await person().click(within(dialog).getByRole('button', { name: 'Erase my account' }));
    await settle();
    expect(field(dialog).getAttribute('aria-invalid')).toBe('true');
    await person().click(within(dialog).getByRole('button', { name: 'Erase my account' }));
    await settle();
    expect(
      within(dialog)
        .getAllByRole('alert')
        .map((alert) => alert.textContent),
    ).toContainEqual(expect.stringContaining('Your account was not erased.') as unknown as string);
  });
});

describe('leaving the workspace (D-152)', () => {
  test('asks first, then leaves, reads the memberships again and goes to the front door', async () => {
    const left: string[] = [];
    let reads = 0;
    const session = aSession();
    const view = await open({
      me: () => {
        reads += 1;
        return Promise.resolve(session);
      },
      leaveWorkspace: (workspaceId) => {
        left.push(workspaceId);
        return Promise.resolve();
      },
    });
    const before = reads;
    await person().click(main(view).getByRole('button', { name: 'Leave workspace…' }));
    const ask = view.getByRole('dialog');
    expect(left).toEqual([]);
    await person().click(within(ask).getByRole('button', { name: /^Leave / }));
    await settle();
    expect(left).toHaveLength(1);
    expect(reads).toBeGreaterThan(before);
    // Through the front door (with `replace`), which sends them on to what they are still in.
    expect(here(view)).not.toBe('/w/acme/settings/account');
    view.unmount();
  });

  test('the last owner is told to hand the workspace on, and stays', async () => {
    const view = await open({
      leaveWorkspace: () =>
        Promise.reject(new ApiError(409, 'LAST_OWNER', 'A workspace keeps at least one owner.')),
    });
    await person().click(main(view).getByRole('button', { name: 'Leave workspace…' }));
    const ask = view.getByRole('dialog');
    await person().click(within(ask).getByRole('button', { name: /^Leave / }));
    await settle();
    expect(within(ask).getByRole('alert').textContent).toContain(
      'make somebody else an owner on Members first',
    );
    expect(here(view)).toBe('/w/acme/settings/account');
    view.unmount();
  });

  test('any other refusal says they did not leave, and why, and stays', async () => {
    const view = await open({
      leaveWorkspace: () => Promise.reject(new ApiError(500, 'INTERNAL', 'x')),
    });
    await person().click(main(view).getByRole('button', { name: 'Leave workspace…' }));
    const ask = view.getByRole('dialog');
    await person().click(within(ask).getByRole('button', { name: /^Leave / }));
    await settle();
    expect(within(ask).getByRole('alert').textContent).toMatch(/^You did not leave\. \S/);
    expect(here(view)).toBe('/w/acme/settings/account');
    view.unmount();
  });

  test('Cancel and Esc each close the question, and nobody leaves', async () => {
    const left: string[] = [];
    const view = await open({
      leaveWorkspace: (workspaceId) => {
        left.push(workspaceId);
        return Promise.resolve();
      },
    });
    await person().click(main(view).getByRole('button', { name: 'Leave workspace…' }));
    await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();

    await person().click(main(view).getByRole('button', { name: 'Leave workspace…' }));
    expect(view.getByRole('dialog')).toBeDefined();
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(left).toEqual([]);
    expect(here(view)).toBe('/w/acme/settings/account');
    view.unmount();
  });

  test('while leaving, the question cannot be closed or cancelled', async () => {
    let finish: (() => void) | undefined;
    const view = await open({
      leaveWorkspace: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    await person().click(main(view).getByRole('button', { name: 'Leave workspace…' }));
    const ask = view.getByRole('dialog');
    await person().click(within(ask).getByRole('button', { name: /^Leave / }));
    await settle();
    expect(within(ask).getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true);
    await person().keyboard('{Escape}');
    await settle();
    expect(view.getByRole('dialog')).toBe(ask);
    await act(async () => {
      finish?.();
      await Promise.resolve();
    });
    await settle();
    expect(here(view)).not.toBe('/w/acme/settings/account');
    view.unmount();
  });
});

describe('how you sign in (D-176)', () => {
  const opened = async (
    api: Partial<Api>,
    path = '/w/acme/settings/account',
  ): Promise<{ view: View; card: Scope }> => {
    const view = await renderApp(<Outlet />, { path, api: aSignedInApi(api) });
    await settle();
    await view.findByRole('heading', { level: 1, name: 'Sessions & account' });
    const card = within(view.getByRole('region', { name: 'How you sign in' }));
    return { view, card };
  };

  const emailAccount: Partial<Api> = {
    mySignIn: () => Promise.resolve({ email: 'ada@example.test', emailLinks: true, github: null }),
  };

  test('an account made by email shows its address and offers Connect GitHub, which leaves for GitHub', async () => {
    const asked: string[] = [];
    const left: string[] = [];
    const leave = leaveFor.go;
    leaveFor.go = (location): void => {
      left.push(location);
    };
    try {
      const { view, card } = await opened({
        ...emailAccount,
        connectGitHub: (workspace) => {
          asked.push(workspace);
          return Promise.resolve({ location: 'https://github.com/login/oauth/authorize?state=s' });
        },
      });
      expect(card.getByText('ada@example.test')).toBeDefined();
      expect(card.getByText('A sign-in link sent to this address signs you in.')).toBeDefined();
      await expectNoAxeViolations(view.getByRole('main'));
      await person().click(card.getByRole('button', { name: 'Connect GitHub' }));
      await settle();
      // From the workspace the page is in, which is where GitHub sends the browser back to.
      expect(asked).toEqual(['acme']);
      expect(left).toEqual(['https://github.com/login/oauth/authorize?state=s']);
      view.unmount();
    } finally {
      leaveFor.go = leave;
    }
  });

  test('a connected account shows the login and no button', async () => {
    const { view, card } = await opened({
      mySignIn: () =>
        Promise.resolve({
          email: 'ada@example.test',
          emailLinks: true,
          github: { login: 'ada-gh' },
        }),
    });
    expect(card.getByText('ada-gh')).toBeDefined();
    expect(card.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
    view.unmount();
  });

  test('an account GitHub made says it signs in with GitHub, not by link', async () => {
    const { view, card } = await opened({
      mySignIn: () =>
        Promise.resolve({ email: 'ada@example.test', emailLinks: false, github: { login: 'ada' } }),
    });
    expect(card.getByText('Your GitHub account’s address. You sign in with GitHub.')).toBeDefined();
    view.unmount();
  });

  test('says how a connect came back, in words, from the address GitHub sent the browser to', async () => {
    const cases = [
      ['connected', 'status', 'GitHub is connected — you can sign in with it from now on.'],
      ['session', 'alert', /^You were signed out, or signed in as somebody else/],
      ['taken', 'alert', /^That GitHub account already signs in to another Purlay account/],
      ['nonsense', 'alert', 'Connecting GitHub did not finish — try again.'],
    ] as const;
    for (const [outcome, role, words] of cases) {
      const { view, card } = await opened(
        emailAccount,
        `/w/acme/settings/account?github=${outcome}`,
      );
      expect(card.getByRole(role).textContent).toMatch(words);
      view.unmount();
    }
  });

  test('a connect that cannot start says why, and an account connected meanwhile is read again', async () => {
    let reads = 0;
    const { view, card } = await opened({
      mySignIn: () => {
        reads += 1;
        return Promise.resolve({
          email: 'ada@example.test',
          emailLinks: true,
          github: reads > 1 ? { login: 'ada-gh' } : null,
        });
      },
      connectGitHub: () => Promise.reject(new ApiError(409, 'GITHUB_ALREADY_CONNECTED', 'already')),
    });
    await person().click(card.getByRole('button', { name: 'Connect GitHub' }));
    await settle();
    expect(card.getByRole('alert').textContent).toBe(
      'GitHub could not be opened. This account has a GitHub account connected already.',
    );
    expect(await card.findByText('ada-gh')).toBeDefined();
    view.unmount();
  });

  test('loading, then a failure to read it, with Retry', async () => {
    let fail = true;
    const { view, card } = await opened({
      mySignIn: () =>
        fail
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'x'))
          : Promise.resolve({ email: 'ada@example.test', emailLinks: true, github: null }),
    });
    expect(await card.findByRole('button', { name: 'Retry' })).toBeDefined();
    fail = false;
    await person().click(card.getByRole('button', { name: 'Retry' }));
    expect(await card.findByText('ada@example.test')).toBeDefined();
    view.unmount();
  });

  test('leaving for GitHub is the browser leaving the page, to where the server said', () => {
    const assign = spyOn(window.location, 'assign').mockImplementation(() => undefined);
    try {
      leaveFor.go('https://github.com/login/oauth/authorize?state=s');
      expect(assign).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?state=s');
    } finally {
      assign.mockRestore();
    }
  });

  test('the address GitHub sends the browser back to is this page’s', () => {
    expect(connectGitHubHref('acme', 'connected').split('?')[0]).toBe(
      href('settings', { slug: 'acme', section: 'account' }),
    );
  });
});
