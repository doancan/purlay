/**
 * Sessions & account (D-11, D-139 §5, D-146), through the real frame at the page's address: signing
 * out here, signing out everywhere — which asks first — and erasing the account, which asks for the
 * username.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import { en } from '../../../i18n/catalogue/en';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError, LibraryFailure } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { expectFocusOn } from '../../../testing/focus';
import { installDom } from '../../../testing/dom';
import { aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';

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

describe('how you sign in (D-176, D-179 §5)', () => {
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
    mySignIn: () =>
      Promise.resolve({
        email: 'ada@example.test',
        emailLinks: true,
        hasPassword: false,
        github: null,
        oidc: false,
        twoFactor: false,
        twoFactorRequired: false,
      }),
  };

  test('an account made by email shows its address, and nothing about GitHub it has none of', async () => {
    const { view, card } = await opened(emailAccount);
    expect(card.getByText('ada@example.test')).toBeDefined();
    expect(card.getByText('A sign-in link sent to this address signs you in.')).toBeDefined();
    // Nothing to press: GitHub is linked by signing in with it, never from here.
    expect(card.queryByRole('button')).toBeNull();
    expect(card.queryByText('GitHub')).toBeNull();
    expect(view.queryByText(/Connect GitHub/)).toBeNull();
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test('an account single sign-on is linked to says so, and that a link sent to its address no longer signs in', async () => {
    const { view, card } = await opened({
      mySignIn: () =>
        Promise.resolve({
          email: 'ada@example.test',
          emailLinks: true,
          hasPassword: false,
          github: null,
          oidc: true,
          twoFactor: false,
          twoFactorRequired: false,
        }),
    });
    expect(card.getByText('Single sign-on')).toBeDefined();
    expect(card.getByText('Linked')).toBeDefined();
    expect(
      card.getByText(
        'Your organisation’s sign-in is linked to this account, and an emailed link no longer signs in to it.',
      ),
    ).toBeDefined();
    expect(card.queryByRole('button')).toBeNull();
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test('a linked account shows the login, read only', async () => {
    const { view, card } = await opened({
      mySignIn: () =>
        Promise.resolve({
          email: 'ada@example.test',
          emailLinks: true,
          hasPassword: false,
          github: { login: 'ada-gh' },
          oidc: false,
          twoFactor: false,
          twoFactorRequired: false,
        }),
    });
    expect(card.getByText('GitHub')).toBeDefined();
    expect(card.getByText('ada-gh')).toBeDefined();
    expect(card.getByText('You can sign in with this GitHub account.')).toBeDefined();
    expect(card.queryByRole('button')).toBeNull();
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test('a GitHub account whose login is not known yet is still said to be linked', async () => {
    const { view, card } = await opened({
      mySignIn: () =>
        Promise.resolve({
          email: 'ada@example.test',
          emailLinks: true,
          hasPassword: false,
          github: { login: null },
          oidc: false,
          twoFactor: false,
          twoFactorRequired: false,
        }),
    });
    expect(card.getByText('Linked')).toBeDefined();
    view.unmount();
  });

  test('an account GitHub made says it signs in with GitHub, not by link', async () => {
    const { view, card } = await opened({
      mySignIn: () =>
        Promise.resolve({
          email: 'ada@example.test',
          emailLinks: false,
          hasPassword: false,
          github: { login: 'ada' },
          oidc: false,
          twoFactor: false,
          twoFactorRequired: false,
        }),
    });
    expect(card.getByText('Your GitHub account’s address. You sign in with GitHub.')).toBeDefined();
    view.unmount();
  });

  test('an address a connect once sent the browser back with says nothing now', async () => {
    const { view, card } = await opened(emailAccount, '/w/acme/settings/account?github=connected');
    expect(card.queryByRole('status')).toBeNull();
    expect(card.queryByRole('alert')).toBeNull();
    view.unmount();
  });

  test('loading, then a failure to read it, with Retry', async () => {
    let fail = true;
    const { view, card } = await opened({
      mySignIn: () =>
        fail
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'x'))
          : Promise.resolve({
              email: 'ada@example.test',
              emailLinks: true,
              hasPassword: false,
              github: null,
              oidc: false,
              twoFactor: false,
              twoFactorRequired: false,
            }),
    });
    expect(await card.findByRole('button', { name: 'Retry' })).toBeDefined();
    fail = false;
    await person().click(card.getByRole('button', { name: 'Retry' }));
    expect(await card.findByText('ada@example.test')).toBeDefined();
    view.unmount();
  });

  test('while it is read, the card says so', async () => {
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/settings/account',
      api: aSignedInApi({ mySignIn: () => new Promise(() => undefined) }),
    });
    await settle();
    await view.findByRole('heading', { level: 1, name: 'Sessions & account' });
    const card = within(view.getByRole('region', { name: 'How you sign in' }));
    expect(card.getByRole('status')).toBeDefined();
    view.unmount();
  });
});

describe('change password', () => {
  const withPassword: Partial<Api> = {
    mySignIn: () =>
      Promise.resolve({
        email: 'admin@example.test',
        emailLinks: true,
        hasPassword: true,
        github: null,
        oidc: false,
        twoFactor: false,
        twoFactorRequired: false,
      }),
  };

  const fill = async (view: View, current: string, next: string): Promise<void> => {
    const user = person();
    await user.type(view.getByLabelText('Current password'), current);
    await user.type(view.getByLabelText('New password'), next);
  };

  test('is drawn only for an account that has a password', async () => {
    const without = await open({
      mySignIn: () =>
        Promise.resolve({
          email: 'a@example.test',
          emailLinks: true,
          hasPassword: false,
          github: null,
          oidc: false,
          twoFactor: false,
          twoFactorRequired: false,
        }),
    });
    expect(without.queryByRole('region', { name: 'Password' })).toBeNull();
    without.unmount();
    const view = await open(withPassword);
    expect(view.getByRole('region', { name: 'Password' })).toBeDefined();
    await expectNoAxeViolations(view.container);
  });

  test('reads the policy as the password is typed, from the shared function', async () => {
    const view = await open(withPassword);
    const user = person();
    const rules = within(view.getByRole('region', { name: 'Password' }));
    await user.type(rules.getByLabelText('New password'), 'short');
    expect(
      rules.getByText('10 to 128 characters, no control characters').parentElement?.className,
    ).toContain('text-danger-text');
    await user.clear(rules.getByLabelText('New password'));
    await user.type(rules.getByLabelText('New password'), 'a-fine-long-passphrase-7');
    expect(
      rules.getByText('10 to 128 characters, no control characters').parentElement?.className,
    ).toContain('text-success-text');
  });

  test('a password the policy refuses is said by rule and nothing is sent', async () => {
    let sent = 0;
    const view = await open({
      ...withPassword,
      changePassword: () => {
        sent += 1;
        return Promise.resolve();
      },
    });
    await fill(view, 'the-old-one-1', 'password123');
    await person().click(view.getByRole('button', { name: 'Change password' }));
    await settle();
    expect(view.getByText('That password is one of the commonest.')).toBeDefined();
    expect(sent).toBe(0);
  });

  test('sends both passwords, says the other sessions were signed out, and empties the fields', async () => {
    const sent: { currentPassword: string; newPassword: string }[] = [];
    const view = await open({
      ...withPassword,
      changePassword: async (input) => {
        sent.push(input);
        await Promise.resolve();
      },
    });
    await fill(view, 'the-old-one-1', 'a-fine-long-passphrase-7');
    await person().click(view.getByRole('button', { name: 'Change password' }));
    await settle();
    expect(sent).toEqual([
      { currentPassword: 'the-old-one-1', newPassword: 'a-fine-long-passphrase-7' },
    ]);
    expect(view.getByText('Your other sessions were signed out.')).toBeDefined();
    expect((view.getByLabelText('New password') as HTMLInputElement).value).toBe('');
  });

  test('is sent when the form itself is submitted, without a page load', async () => {
    const sent: { currentPassword: string; newPassword: string }[] = [];
    const view = await open({
      ...withPassword,
      changePassword: (input) => {
        sent.push(input);
        return Promise.resolve();
      },
    });
    await fill(view, 'the-old-one-1', 'a-fine-long-passphrase-7');
    const form = view.getByRole('form', { name: 'Password' });
    expect(fireEvent.submit(form)).toBe(false);
    await settle();
    expect(sent).toEqual([
      { currentPassword: 'the-old-one-1', newPassword: 'a-fine-long-passphrase-7' },
    ]);
    expect(view.getByText('Your other sessions were signed out.')).toBeDefined();
  });

  test("the button is the form's own submit button, so the Enter key in a field presses it", async () => {
    // A form with several fields and no submit button of its own is not submitted by Enter. The button
    // sits in the card's footer, outside the form, so the `form` attribute is what joins them.
    const sent: { currentPassword: string; newPassword: string }[] = [];
    const view = await open({
      ...withPassword,
      changePassword: (input) => {
        sent.push(input);
        return Promise.resolve();
      },
    });
    await fill(view, 'the-old-one-1', 'a-fine-long-passphrase-7');
    const button = view.getByRole('button', { name: 'Change password' }) as HTMLButtonElement;
    expect(button.type).toBe('submit');
    expect(button.form === view.getByRole('form', { name: 'Password' })).toBe(true);
    await person().click(button);
    await settle();
    expect(sent).toHaveLength(1);
  });

  test.each([
    [new LibraryFailure(400, 'INVALID_PASSWORD'), 'That is not your current password.'],
    [
      new LibraryFailure(400, 'PASSWORD_TOO_WEAK', 'contains-name'),
      'That password contains your name.',
    ],
    [new LibraryFailure(400, 'PASSWORD_TOO_SHORT'), 'That password is too short.'],
    [new LibraryFailure(400, 'PASSWORD_TOO_LONG'), 'That password is too long.'],
    [new LibraryFailure(0, 'NETWORK'), en['settings.account.password.unreachable']],
    [
      new LibraryFailure(429, 'RATE_LIMITED', null, 900),
      'Too many attempts. Try again in 15 minutes.',
    ],
    [
      new LibraryFailure(500, 'OTHER_SESSIONS_NOT_ENDED'),
      en['settings.account.password.othersStay'],
    ],
    [
      new LibraryFailure(500, 'INTERNAL_SERVER_ERROR'),
      'The password was not changed. Try again in a moment.',
    ],
  ])(
    '%s is said in one sentence, without the sessions being called signed out',
    async (failure, words) => {
      const view = await open({ ...withPassword, changePassword: () => Promise.reject(failure) });
      await fill(view, 'the-old-one-1', 'a-fine-long-passphrase-7');
      await person().click(view.getByRole('button', { name: 'Change password' }));
      await settle();
      expect(view.getByText(words)).toBeDefined();
      expect(view.queryByText('Your other sessions were signed out.')).toBeNull();
    },
  );
});
