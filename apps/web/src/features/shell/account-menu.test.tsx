/**
 * The account menu at the sidebar's foot (D-124), as a person meets it through the real frame:
 * Deep Work for a chosen while, the preferences, and the two ways to sign out.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { MeResponse, SetDeepWorkRequest } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { expectFocusOn } from '../../testing/focus';
import { installDom } from '../../testing/dom';
import { IDS, aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { deepWorkEnd } from './deep-work';

installDom();

const NOON = Date.UTC(2026, 8, 9, 12, 0, 0);
const after = (minutes: number): string => new Date(NOON + minutes * 60_000).toISOString();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const session = (deepWorkUntil: string | null): MeResponse => {
  const me = aSession();
  return { ...me, memberships: me.memberships.map((m) => ({ ...m, deepWorkUntil })) };
};

type View = Awaited<ReturnType<typeof renderApp>>;

const open = async (api: Partial<Api> = {}, deepWorkUntil: string | null = null): Promise<View> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    {
      path: `/w/acme/c/${IDS.api}`,
      api: aSignedInApi({ me: () => Promise.resolve(session(deepWorkUntil)), ...api }),
    },
  );
  await settle();
  return view;
};

const menu = async (view: View): Promise<void> => {
  await person().click(view.getByRole('button', { name: 'Account: Dogancan' }));
};

const here = (view: View): string => view.world.history.stack.at(-1) ?? '';

describe('the account menu', () => {
  test('offers Deep Work for a while, the theme, the language, the shortcuts and both sign-outs', async () => {
    const view = await open();
    await menu(view);
    expect(view.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Your profile…',
      'For 30 minutes',
      'For 1 hour',
      'For 2 hours',
      'Until tomorrow',
      expect.stringMatching(/^Keyboard shortcuts/) as unknown as string,
      'Sign out',
      'Sign out everywhere…',
      'Erase my account…',
    ]);
    expect(view.getAllByRole('menuitemradio').map((item) => item.textContent)).toEqual([
      'System',
      'Light',
      'Dark',
      'English',
      'Türkçe',
    ]);
    await expectNoAxeViolations(view.getByRole('menu'));
    view.unmount();
  });

  test.each([
    ['For 30 minutes', 30],
    ['For 1 hour', 60],
    ['For 2 hours', 120],
  ] as const)(
    '%s starts Deep Work until then, on the server, painted at once',
    async (label, minutes) => {
      const asked: SetDeepWorkRequest[] = [];
      const view = await open({
        setDeepWork: (_workspace, input) => {
          asked.push(input);
          return new Promise(() => undefined);
        },
      });
      await menu(view);
      await person().click(view.getByRole('menuitem', { name: label }));
      expect(asked).toEqual([{ active: true, until: after(minutes) }]);
      await settle();
      expect(view.getByText(/Deep Work until/)).toBeDefined();
      view.unmount();
    },
  );

  test('until tomorrow asks for tomorrow morning, as the rule says', async () => {
    const asked: SetDeepWorkRequest[] = [];
    const view = await open({
      setDeepWork: (_workspace, input) => {
        asked.push(input);
        return new Promise(() => undefined);
      },
    });
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Until tomorrow' }));
    expect(asked).toEqual([
      { active: true, until: deepWorkEnd('tomorrow', new Date(NOON)).toISOString() },
    ]);
    view.unmount();
  });

  test('on, it says until when and how long is left, and ends it', async () => {
    const asked: SetDeepWorkRequest[] = [];
    const view = await open(
      {
        setDeepWork: (_workspace, input) => {
          asked.push(input);
          return Promise.resolve({ until: null });
        },
      },
      after(42),
    );
    await menu(view);
    expect(view.getByText(/^Deep Work until .*, 42 minutes left$/)).toBeDefined();
    expect(view.queryByRole('menuitem', { name: 'For 1 hour' })).toBeNull();
    await person().click(view.getByRole('menuitem', { name: 'End Deep Work' }));
    await settle();
    expect(asked).toEqual([{ active: false }]);
    expect(view.queryByText(/Deep Work until/)).toBeNull();
    view.unmount();
  });

  test('a theme chosen here is applied and kept', async () => {
    const view = await open();
    await menu(view);
    await person().click(view.getByRole('menuitemradio', { name: 'Dark' }));
    expect(view.world.themeStorage.data['purlay.theme']).toBe('dark');
    view.unmount();
  });
});

describe('signing out', () => {
  test('asks, forgets the page, and goes to sign-in without a way Back', async () => {
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
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Sign out' }));
    await settle();
    expect(signedOut).toBe(true);
    expect(here(view)).toBe('/sign-in');
    expect(view.world.history.stack).toEqual(['/sign-in']);
    view.unmount();
  });

  test('a refused sign-out says so, in words that fit the cause, and leaves the person where they were', async () => {
    const view = await open({
      signOut: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Sign out' }));
    await settle();
    expect(
      view.getByText("Couldn't sign you out. Check your connection and try again."),
    ).toBeDefined();
    expect(here(view)).not.toBe('/sign-in');
    view.unmount();
  });

  test('forgets what the browser kept for this person — drafts, the last channel, unsent messages — and keeps the theme', async () => {
    // As the server answers: once signed out, nobody is (the sign-in screen asks, #694).
    let signedIn = true;
    const view = await open({
      me: () =>
        signedIn
          ? Promise.resolve(session(null))
          : Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'signed out')),
      signOut: () => {
        signedIn = false;
        return Promise.resolve();
      },
    });
    const { storage } = view.world;
    storage.setItem('purlay.draft.c1', 'half a thought');
    storage.setItem('purlay.draft.c1.t9', 'half a reply');
    storage.setItem('purlay.lastChannel.w1', 'c1');
    storage.setItem('purlay.pending.u1', '[]');
    storage.setItem('purlay.theme', 'dark');
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Sign out' }));
    await settle();
    expect(Object.keys(storage.data)).toEqual(['purlay.theme']);
    view.unmount();
  });

  test('a refused sign-out forgets nothing: the person is still signed in with their drafts', async () => {
    const view = await open({
      signOut: () => Promise.reject(new ApiError(500, 'INTERNAL', 'x')),
    });
    view.world.storage.setItem('purlay.draft.c1', 'keep me');
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Sign out' }));
    await settle();
    expect(view.world.storage.data['purlay.draft.c1']).toBe('keep me');
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
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Sign out everywhere…' }));
    const dialog = view.getByRole('dialog', { name: 'Sign out everywhere?' });
    await expectNoAxeViolations(dialog);
    await person().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(asked).toEqual([]);
    expect(here(view)).not.toBe('/sign-in');
    view.unmount();
  });

  test('Cancel gives focus back to the account button: the menu item that opened it is gone', async () => {
    const view = await open(counted().api);
    const trigger = view.getByRole('button', { name: 'Account: Dogancan' });
    act(() => {
      trigger.focus();
    });
    await person().keyboard('{Enter}');
    await settle();
    const item = view.getByRole('menuitem', { name: 'Sign out everywhere…' });
    act(() => {
      item.focus();
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
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Sign out everywhere…' }));
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
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Sign out everywhere…' }));
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
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Erase my account…' }));
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
    await menu(view);
    await person().click(view.getByRole('menuitem', { name: 'Erase my account…' }));
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
