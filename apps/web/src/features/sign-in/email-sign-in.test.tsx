/**
 * Signing in by email (D-138), against the fake API: the form on the sign-in card where the server
 * sends mail — sent, refused, switched off, failed — carrying the tab's invitation; and the link's page,
 * which takes the token out of the address, shows whose it is, and spends it only on **Sign in**, with
 * each state — no token, not found, failed with Retry — in both languages.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import type { EmailSignInRequest } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { WORKSPACE, aSession, aSignedInApi } from '../../testing/fixtures';
import { person } from '../../testing/user';
import { renderApp } from '../../testing/render';
import { expectFocusOn } from '../../testing/focus';
import { readSignInLink } from './email-sign-in-screen';

installDom();

const TOKEN = 'a'.repeat(64);
const INVITATION = 'c'.repeat(64);
const KEY = 'purlay.invitation';

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/**
 * Signed out until a link is spent, then signed in — as the cookie the answer sets would make it — so
 * where the page sends the person is where they land.
 */
const signedOut = (overrides: Partial<Api>): Api => {
  let signedIn = false;
  return aSignedInApi({
    me: () =>
      signedIn
        ? Promise.resolve(aSession())
        : Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
    authMethods: () => Promise.resolve({ github: true, email: true, signUp: 'invite-only' }),
    ...overrides,
    ...(overrides.consumeEmailSignIn === undefined
      ? {}
      : {
          consumeEmailSignIn: async (token: string): Promise<void> => {
            await overrides.consumeEmailSignIn?.(token);
            signedIn = true;
          },
        }),
  });
};

const visit = async (
  path: string,
  api: Api,
  locale: 'en' | 'tr' = 'en',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, { path, api, locale });
  await settle();
  return view;
};

const here = (view: Awaited<ReturnType<typeof renderApp>>): string =>
  view.world.history.stack.at(-1) ?? '';

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('the email form on the sign-in card', () => {
  const ask = async (view: Awaited<ReturnType<typeof renderApp>>, email: string): Promise<void> => {
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'Email address' }), email);
    await user.click(view.getByRole('button', { name: 'Email me a sign-in link instead' }));
    await settle();
  };

  test('asks in the reader’s language, says the same whatever the address, and can start again', async () => {
    const asked: EmailSignInRequest[] = [];
    const view = await visit(
      '/sign-in',
      signedOut({
        requestEmailSignIn: async (input) => {
          asked.push(input);
          await Promise.resolve();
        },
      }),
    );
    await expectNoAxeViolations(view.container);
    await ask(view, ' ada@example.test ');
    expect(asked).toEqual([{ email: 'ada@example.test', locale: 'en' }]);
    const said = view.getByRole('status');
    expect(said.textContent).toContain(
      'If ada@example.test can sign in by email, a link is on its way. It works once, for 15 minutes.',
    );
    // The button pressed is gone: focus is on what replaced it, so a screen reader reads it.
    expectFocusOn(said);
    await person().click(view.getByRole('button', { name: 'Use another address' }));
    await settle();
    expectFocusOn(view.getByRole('textbox', { name: 'Email address' }));
  });

  test('carries the invitation this tab holds, since the mail opens in another', async () => {
    window.sessionStorage.setItem(KEY, INVITATION);
    const asked: EmailSignInRequest[] = [];
    const view = await visit(
      '/sign-in',
      signedOut({
        requestEmailSignIn: async (input) => {
          asked.push(input);
          await Promise.resolve();
        },
      }),
      'tr',
    );
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'E-posta adresi' }), 'ada@example.test');
    await user.click(
      view.getByRole('button', { name: 'Bunun yerine bana giriş bağlantısı gönder' }),
    );
    await settle();
    expect(asked).toEqual([{ email: 'ada@example.test', locale: 'tr', invitation: INVITATION }]);
    expect(view.getByRole('status').textContent).toContain('bağlantı yolda');
  });

  test('a refused address is said under the field, which is marked wrong', async () => {
    const view = await visit(
      '/sign-in',
      signedOut({
        requestEmailSignIn: () =>
          Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no', { email: 'is not' })),
      }),
    );
    await ask(view, 'ada@example.test');
    const field = view.getByRole('textbox', { name: 'Email address' });
    expect(field.getAttribute('aria-invalid')).toBe('true');
    const described = document.getElementById(field.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe('That is not an email address.');
    // The field's own message is the only thing said: nothing above the button.
    expect(view.getAllByRole('alert').map((alert) => alert.id)).toEqual([described?.id ?? 'none']);
  });

  test.each([
    [
      new ApiError(503, 'EMAIL_SIGN_IN_UNAVAILABLE', 'off'),
      'This server does not sign in by email',
    ],
    [new ApiError(0, 'NETWORK', 'offline'), 'The link could not be asked for.'],
  ])('%s is said above the button, and the form stays', async (failure, words) => {
    const view = await visit(
      '/sign-in',
      signedOut({ requestEmailSignIn: () => Promise.reject(failure) }),
    );
    await ask(view, 'ada@example.test');
    expect(view.getByRole('alert').textContent).toContain(words);
    expect(
      view.getByRole('textbox', { name: 'Email address' }).getAttribute('aria-invalid'),
    ).toBeNull();
    expect(view.getByRole('textbox', { name: 'Email address' })).toBeDefined();
    expect(view.queryByRole('status')).toBeNull();
  });

  test('until the server says it sends mail, or if it cannot say, the card offers no form', async () => {
    const pending = await visit(
      '/sign-in',
      signedOut({ authMethods: () => new Promise(() => undefined) }),
    );
    expect(pending.queryByRole('textbox')).toBeNull();
    // Nor a button it has not been told works: the card waits for the server's word (`UX.md` §11).
    expect(pending.queryByRole('link', { name: 'Continue with GitHub' })).toBeNull();
    pending.unmount();
    const failing = await visit(
      '/sign-in',
      signedOut({ authMethods: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')) }),
    );
    expect(failing.queryByRole('textbox')).toBeNull();
  });
});

describe('a sign-in link, opened', () => {
  const open = async (
    fragment: string,
    api: Partial<Api>,
    locale: 'en' | 'tr' = 'en',
  ): Promise<Awaited<ReturnType<typeof renderApp>>> => {
    window.history.replaceState(null, '', `/sign-in/email${fragment}`);
    return await visit('/sign-in/email', signedOut(api), locale);
  };

  test('reads a token, or a token and an invitation, and nothing else', () => {
    expect(readSignInLink(`#${TOKEN}`)).toEqual({ token: TOKEN, invitation: null });
    expect(readSignInLink(`#${TOKEN}.${INVITATION}`)).toEqual({
      token: TOKEN,
      invitation: INVITATION,
    });
    for (const hash of [
      '',
      '#',
      `#${TOKEN}.`,
      `#${TOKEN.slice(1)}`,
      `#${TOKEN.toUpperCase()}`,
      `#${TOKEN}x`,
    ]) {
      expect(readSignInLink(hash)).toBeNull();
    }
  });

  test('shows whose link it is, takes the token out of the address, and spends nothing until Sign in', async () => {
    const consumed: string[] = [];
    const view = await open(`#${TOKEN}.${INVITATION}`, {
      previewEmailSignIn: () => Promise.resolve({ email: 'ada@example.test' }),
      consumeEmailSignIn: async (token) => {
        consumed.push(token);
        await Promise.resolve();
      },
    });
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/sign-in/email');
    expect(view.getByText('You are signing in as ada@example.test.')).toBeDefined();
    expect(consumed).toEqual([]);
    await expectNoAxeViolations(view.container);

    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Sign in' }));
    });
    await settle();
    expect(consumed).toEqual([TOKEN]);
    // The invitation the link carried is this tab's now, and home takes the person to it.
    expect(window.sessionStorage.getItem(KEY)).toBe(INVITATION);
    expect(here(view)).toBe('/invite');
    // Replaced, not pushed: Back does not return to a spent link.
    expect(view.world.history.stack).not.toContain('/sign-in/email');
  });

  test('a link with no token says so, and asks nothing', async () => {
    const view = await open('#nothing', {});
    expect(view.getByText(/This link is not complete/)).toBeDefined();
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Back to sign in' }));
    });
    expect(here(view)).toBe('/sign-in');
  });

  test('a link used or expired is one sentence, when shown or when spent', async () => {
    const shown = await open(`#${TOKEN}`, {
      previewEmailSignIn: () => Promise.reject(new ApiError(404, 'SIGN_IN_LINK_NOT_FOUND', 'no')),
    });
    expect(shown.getByText(/This link has been used or has expired/)).toBeDefined();
    shown.unmount();

    const spent = await open(`#${TOKEN}`, {
      previewEmailSignIn: () => Promise.resolve({ email: 'ada@example.test' }),
      consumeEmailSignIn: () => Promise.reject(new ApiError(404, 'SIGN_IN_LINK_NOT_FOUND', 'no')),
    });
    act(() => {
      fireEvent.click(spent.getByRole('button', { name: 'Sign in' }));
    });
    await settle();
    expect(spent.getByText(/This link has been used or has expired/)).toBeDefined();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test('a failure to show it offers Retry, which asks again', async () => {
    let calls = 0;
    const view = await open(`#${TOKEN}`, {
      previewEmailSignIn: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(0, 'NETWORK', 'offline');
        return await Promise.resolve({ email: 'ada@example.test' });
      },
    });
    expect(view.getByRole('heading', { name: 'Signing in did not finish.' })).toBeDefined();
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    });
    await settle();
    expect(view.getByText('You are signing in as ada@example.test.')).toBeDefined();
  });

  test('a failure to sign in is said, and Sign in is there to press again', async () => {
    let calls = 0;
    const view = await open(
      `#${TOKEN}`,
      {
        previewEmailSignIn: () => Promise.resolve({ email: 'ada@example.test' }),
        consumeEmailSignIn: async () => {
          calls += 1;
          if (calls === 1) throw new ApiError(0, 'NETWORK', 'offline');
          await Promise.resolve();
        },
      },
      'tr',
    );
    expect(view.getByText('ada@example.test olarak giriş yapıyorsun.')).toBeDefined();
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Giriş yap' }));
    });
    await settle();
    expect(view.getByRole('alert').textContent).toContain('Giriş tamamlanamadı.');
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Giriş yap' }));
    });
    await settle();
    // Signed in, with no invitation in hand: home sends the person into their workspace.
    expect(here(view).startsWith(`/w/${WORKSPACE.slug}`)).toBe(true);
  });

  test('while it is read, says so', async () => {
    const view = await open(`#${TOKEN}`, {
      previewEmailSignIn: () => new Promise(() => undefined),
    });
    expect(view.getByRole('status')).toBeDefined();
  });

  test('a failure to sign in puts focus back on Sign in; a spent link, on the way back', async () => {
    let calls = 0;
    const view = await open(`#${TOKEN}`, {
      previewEmailSignIn: () => Promise.resolve({ email: 'ada@example.test' }),
      consumeEmailSignIn: async () => {
        calls += 1;
        await Promise.resolve();
        throw calls === 1
          ? new ApiError(0, 'NETWORK', 'offline')
          : new ApiError(404, 'SIGN_IN_LINK_NOT_FOUND', 'no');
      },
    });
    await person().click(view.getByRole('button', { name: 'Sign in' }));
    await settle();
    expectFocusOn(view.getByRole('button', { name: 'Sign in' }));
    await person().click(view.getByRole('button', { name: 'Sign in' }));
    await settle();
    expectFocusOn(view.getByRole('button', { name: 'Back to sign in' }));
  });

  test('somebody already signed in on this page is told the link signs them in as someone else', async () => {
    window.history.replaceState(null, '', `/sign-in/email#${TOKEN}`);
    const view = await visit(
      '/sign-in/email',
      aSignedInApi({
        previewEmailSignIn: () => Promise.resolve({ email: 'ada@example.test' }),
      }),
    );
    expect(view.getByRole('note').textContent).toBe(
      'You are signed in on this page as dogancan@example.test; this link signs you in instead.',
    );
  });

  test('nobody signed in is told nothing more', async () => {
    const view = await open(`#${TOKEN}`, {
      previewEmailSignIn: () => Promise.resolve({ email: 'ada@example.test' }),
    });
    expect(view.queryByRole('note')).toBeNull();
  });
});
