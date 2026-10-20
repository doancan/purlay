/**
 * The account menu at the sidebar's foot (D-124, D-146), as a person meets it through the real frame:
 * Deep Work for a chosen while, the door to Settings, and signing out. Signing out everywhere and
 * erasing the account are the Sessions & account page's (`settings/pages/account.test.tsx`).
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { MeResponse, SetDeepWorkRequest } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
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
  test('offers Deep Work for a while, Settings, the shortcuts and signing out — nothing that is a page of Settings', async () => {
    const view = await open();
    await menu(view);
    expect(view.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'For 30 minutes',
      'For 1 hour',
      'For 2 hours',
      'Until tomorrow',
      expect.stringMatching(/^Settings/) as unknown as string,
      expect.stringMatching(/^Keyboard shortcuts/) as unknown as string,
      'Sign out',
    ]);
    // The theme and the language are Preferences'; signing out everywhere and erasing, Sessions & account's.
    expect(view.queryAllByRole('menuitemradio')).toEqual([]);
    await expectNoAxeViolations(view.getByRole('menu'));
    view.unmount();
  });

  test('Settings opens the person’s Profile page, and the menu says its shortcut', async () => {
    const view = await open();
    await menu(view);
    const item = view.getByRole('menuitem', { name: /^Settings/ });
    expect(item.textContent).toMatch(/,$/);
    await person().click(item);
    expect(await view.findByRole('heading', { level: 1, name: 'Profile' })).toBeDefined();
    expect(here(view)).toBe('/w/acme/settings/profile');
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
