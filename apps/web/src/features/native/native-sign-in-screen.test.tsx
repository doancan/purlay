/**
 * `/sign-in/native` (D-191, `UX.md` §11): the page the native application sends a person to, where, signed
 * in, they say yes — each state, the way out of each, and what the tab keeps, in both languages.
 *
 * The page never mints a code by being opened: only the button does, and only for the pair the
 * application's own link left in this tab.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import type { NativeAuthorizeRequest } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { expectFocusOn } from '../../testing/focus';
import { aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { systemClock } from '../../system-clock';
import { leave } from '../sign-in/leave';
import { HANDOFF_TTL_MS } from './pending';

installDom();

const KEY = 'purlay.native';
const PAIR = { challenge: 'a'.repeat(43), state: 'b'.repeat(22) };
const REDIRECT = `purlay://auth?code=${'c'.repeat(64)}&state=${PAIR.state}`;
const NOW = (): number => systemClock.now().getTime();

const hold = (at = NOW()): void => {
  window.sessionStorage.setItem(KEY, JSON.stringify({ ...PAIR, at }));
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const visit = async (
  api: Partial<Api> = {},
  { locale = 'en', path = '/sign-in/native' }: { locale?: 'en' | 'tr'; path?: string } = {},
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, {
    path,
    api: aSignedInApi({ authorizeNative: () => Promise.resolve({ redirect: REDIRECT }), ...api }),
    locale,
  });
  await settle();
  return view;
};

const here = (view: Awaited<ReturnType<typeof renderApp>>): string =>
  view.world.history.stack.at(-1) ?? '';

const click = async (
  view: Awaited<ReturnType<typeof renderApp>>,
  name: string | RegExp,
): Promise<void> => {
  act(() => {
    fireEvent.click(view.getByRole('button', { name }));
  });
  await settle();
};

afterEach(() => {
  window.sessionStorage.clear();
});

describe('the consent', () => {
  test('names the account, its address and the server, and offers three ways on — and opens nothing by being opened', async () => {
    hold();
    const asked: NativeAuthorizeRequest[] = [];
    const view = await visit({
      authorizeNative: (input) => {
        asked.push(input);
        return Promise.resolve({ redirect: REDIRECT });
      },
    });
    expect(view.getByRole('heading', { name: 'Open Purlay for Mac?' })).toBeDefined();
    const body = view.container.textContent;
    expect(body).toContain('dogancan@example.test');
    expect(body).toContain(window.location.host);
    expect(view.getByRole('button', { name: 'Open Purlay for Mac' })).toBeDefined();
    expect(view.getByRole('button', { name: 'Cancel' })).toBeDefined();
    expect(
      view.getByRole('button', { name: 'Sign out of this browser and use another account' }),
    ).toBeDefined();
    // A page that minted a code as it opened would hand an account to whoever sent the link.
    expect(asked).toEqual([]);
    await expectNoAxeViolations(view.container);
  });

  test('puts focus on the button that goes on, so the keyboard is a way through', async () => {
    hold();
    const view = await visit();
    expectFocusOn(view.getByRole('button', { name: 'Open Purlay for Mac' }));
  });

  test('is in Turkish for a person who reads it so', async () => {
    hold();
    const view = await visit({}, { locale: 'tr' });
    expect(view.getByRole('heading', { name: 'Purlay for Mac açılsın mı?' })).toBeDefined();
    expect(view.getByRole('button', { name: 'Purlay for Mac’i aç' })).toBeDefined();
    await expectNoAxeViolations(view.container);
  });
});

describe('saying yes', () => {
  test('asks for the pair the tab holds, sends the browser to the address the server named, and forgets the pair', async () => {
    hold();
    const asked: NativeAuthorizeRequest[] = [];
    const went = spyOn(leave, 'to').mockImplementation(() => undefined);
    try {
      const view = await visit({
        authorizeNative: (input) => {
          asked.push(input);
          return Promise.resolve({ redirect: REDIRECT });
        },
      });
      await click(view, 'Open Purlay for Mac');
      expect(asked).toEqual([PAIR]);
      expect(went).toHaveBeenCalledWith(REDIRECT);
      expect(window.sessionStorage.getItem(KEY)).toBeNull();
      expect(view.getByRole('heading', { name: 'Back to Purlay for Mac' })).toBeDefined();
      await expectNoAxeViolations(view.container);
    } finally {
      went.mockRestore();
    }
  });

  test('can open the application again from the same code, without making another', async () => {
    hold();
    let made = 0;
    const went = spyOn(leave, 'to').mockImplementation(() => undefined);
    try {
      const view = await visit({
        authorizeNative: () => {
          made += 1;
          return Promise.resolve({ redirect: REDIRECT });
        },
      });
      await click(view, 'Open Purlay for Mac');
      await click(view, 'Open Purlay for Mac again');
      expect(made).toBe(1);
      expect(went.mock.calls).toEqual([[REDIRECT], [REDIRECT]]);
    } finally {
      went.mockRestore();
    }
  });

  test('says what failed above the button, and tries again on Retry — keeping the pair meanwhile', async () => {
    hold();
    let calls = 0;
    const went = spyOn(leave, 'to').mockImplementation(() => undefined);
    try {
      const view = await visit({
        authorizeNative: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new ApiError(0, 'NETWORK', 'down'))
            : Promise.resolve({ redirect: REDIRECT });
        },
      });
      await click(view, 'Open Purlay for Mac');
      expect(view.getByRole('alert').textContent).toContain('Purlay for Mac was not opened.');
      expect(window.sessionStorage.getItem(KEY)).not.toBeNull();
      expect(went).not.toHaveBeenCalled();
      await click(view, 'Retry');
      expect(went).toHaveBeenCalledWith(REDIRECT);
    } finally {
      went.mockRestore();
    }
  });

  test('a session that ended meanwhile goes to sign-in, with the pair kept for after', async () => {
    hold();
    let ended = false;
    const view = await visit({
      authorizeNative: () => {
        ended = true;
        return Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Sign in first.'));
      },
      // As the server answers once the session is gone.
      me: () =>
        ended
          ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Sign in first.'))
          : Promise.resolve(aSession()),
    });
    await click(view, 'Open Purlay for Mac');
    expect(window.sessionStorage.getItem(KEY)).not.toBeNull();
    // The screen that already says a session ended, so the person is told why they are here.
    expect(here(view)).toBe('/sign-in?reason=ended');
  });
});

describe('the other ways out', () => {
  test('Cancel forgets the pair and goes home, and asks for nothing', async () => {
    hold();
    let made = 0;
    const view = await visit({
      authorizeNative: () => {
        made += 1;
        return Promise.resolve({ redirect: REDIRECT });
      },
    });
    await click(view, 'Cancel');
    expect(made).toBe(0);
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(here(view)).not.toBe('/sign-in/native');
  });

  test('signing out to use another account ends this browser’s session, keeps the pair, and goes to sign-in', async () => {
    hold();
    let signedOut = 0;
    const view = await visit({
      signOut: () => {
        signedOut += 1;
        return Promise.resolve();
      },
      // As the server answers once the session is gone.
      me: () =>
        signedOut === 0
          ? Promise.resolve(aSession())
          : Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Sign in first.')),
    });
    await click(view, 'Sign out of this browser and use another account');
    expect(signedOut).toBe(1);
    expect(window.sessionStorage.getItem(KEY)).not.toBeNull();
    expect(here(view)).toBe('/sign-in');
  });
});

describe('a page with nothing to answer', () => {
  test('without a pair, says the sign-in is not there, with the way home', async () => {
    const view = await visit();
    expect(view.getByRole('heading', { name: 'This sign-in has expired' })).toBeDefined();
    await expectNoAxeViolations(view.container);
    await click(view, 'Go to Purlay');
    expect(here(view)).not.toBe('/sign-in/native');
  });

  test('a pair that is ten minutes old is not a question any more', async () => {
    hold(NOW() - HANDOFF_TTL_MS);
    const view = await visit();
    expect(view.getByRole('heading', { name: 'This sign-in has expired' })).toBeDefined();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test('is in Turkish for a person who reads it so', async () => {
    const view = await visit({}, { locale: 'tr' });
    expect(
      view.getByRole('heading', { name: 'Bu oturum açma isteğinin süresi doldu' }),
    ).toBeDefined();
  });
});

describe('a person who is not signed in yet', () => {
  test('is sent to sign-in, and the pair waits in the tab', async () => {
    hold();
    const view = await visit({
      me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'Sign in first.')),
    });
    expect(here(view)).toBe('/sign-in');
    expect(window.sessionStorage.getItem(KEY)).not.toBeNull();
  });
});

describe('back from signing in', () => {
  test('the front door takes a person with a pair waiting to the consent', async () => {
    hold();
    const view = await visit({}, { path: '/' });
    expect(here(view)).toBe('/sign-in/native');
    expect(view.getByRole('heading', { name: 'Open Purlay for Mac?' })).toBeDefined();
  });

  test('without a pair, takes them to their workspace as it always did', async () => {
    const view = await visit({}, { path: '/' });
    expect(here(view)).not.toBe('/sign-in/native');
  });

  test('a pair that went stale on the way is not taken to', async () => {
    hold(NOW() - HANDOFF_TTL_MS - 1);
    const view = await visit({}, { path: '/' });
    expect(here(view)).not.toBe('/sign-in/native');
  });

  test('an invitation in hand comes first, and the pair is kept for after', async () => {
    hold();
    window.sessionStorage.setItem('purlay.invitation', 'd'.repeat(64));
    const view = await visit({}, { path: '/' });
    expect(here(view)).toBe('/invite');
    expect(window.sessionStorage.getItem(KEY)).not.toBeNull();
  });
});
