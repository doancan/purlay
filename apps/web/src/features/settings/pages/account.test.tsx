/**
 * Sessions & account (D-11, D-139 §5, D-146), through the real frame at the page's address: signing
 * out here, signing out everywhere — which asks first — and erasing the account, which asks for the
 * username.
 */
import { describe, expect, test } from 'bun:test';
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
