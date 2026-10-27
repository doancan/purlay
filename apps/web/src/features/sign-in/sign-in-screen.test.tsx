/**
 * The sign-in screen's sentence for a round trip that did not finish (D-121): one per reason in
 * `SignInFailure`, in both languages, each saying what to do and none blaming. The reasons come off
 * the contract, so a reason added there is a case here without anyone remembering to write it.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { SignInFailure, signInFailureHref, type AuthMethods } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { renderApp } from '../../testing/render';
import { systemClock } from '../../system-clock';
import type { Locale } from '../../i18n/types';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const EVERY_FAILURE = SignInFailure.anyOf.map((literal) => literal.const);

const signedOut = (mail: boolean, github = true): ReturnType<typeof anApi> =>
  anApi({
    me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
    authMethods: () => Promise.resolve({ github, email: mail, oidc: null, signUp: 'invite-only' }),
  });

/** The one sentence the screen says about the way here, or null when it says none. */
const saidAt = async (path: string, locale: Locale, mail = false): Promise<string | null> => {
  const view = await renderApp(<Outlet />, { path, api: signedOut(mail), locale });
  await settle();
  const status = view.queryByRole('status');
  const words = status === null ? null : status.textContent;
  view.unmount();
  return words;
};

/** Words that put the fault on the person (D-121: what happened, then what to do; none blames). */
const BLAMING = /\b(you (failed|should have|did not|didn’t)|your fault|invalid|illegal|wrong)\b/i;

describe('the sentence for each reason a sign-in came back unfinished', () => {
  for (const locale of ['en', 'tr'] as const) {
    for (const mail of [true, false]) {
      test(`each reason has one, in ${locale} ${mail ? 'with' : 'without'} mail, and no two are the same`, async () => {
        const sentences: string[] = [];
        for (const failure of EVERY_FAILURE) {
          const words = await saidAt(signInFailureHref(failure), locale, mail);
          expect(words, `${failure} in ${locale}`).not.toBeNull();
          expect(words?.length ?? 0).toBeGreaterThan(20);
          expect(words ?? '').not.toMatch(BLAMING);
          // A catalogue key left unsaid would show as itself.
          expect(words ?? '').not.toMatch(/^signIn\./);
          sentences.push(words ?? '');
        }
        expect(new Set(sentences).size).toBe(EVERY_FAILURE.length);
      });
    }
  }

  test('an invite-only server says to ask for an invitation link, in both languages', async () => {
    expect(await saidAt(signInFailureHref('signup-closed'), 'en')).toBe(
      'This Purlay server makes accounts by invitation only — ask someone on it for an invitation link.',
    );
    expect(await saidAt(signInFailureHref('signup-closed'), 'tr')).toBe(
      'Bu Purlay sunucusunda hesap yalnızca davetle açılır — sunucudaki birinden davet bağlantısı iste.',
    );
  });

  test('an unverified address says to sign in with its password, on a server with mail and without', async () => {
    for (const mail of [true, false]) {
      const en = await saidAt(signInFailureHref('email-taken'), 'en', mail);
      expect(en).toContain('password');
      expect(en ?? '').not.toMatch(/link sent to that address/i);
      const tr = await saidAt(signInFailureHref('email-taken'), 'tr', mail);
      expect(tr).toContain('parola');
    }
  });

  test('without mail it says the address stays unverified, because nothing will mail it', async () => {
    expect(await saidAt(signInFailureHref('email-taken'), 'en', false)).toContain(
      'This server sends no email',
    );
    expect(await saidAt(signInFailureHref('email-taken'), 'tr', false)).toContain(
      'e-posta göndermiyor',
    );
  });
});

describe('what the screen offers is what the server has connected', () => {
  const GITHUB = 'Continue with GitHub';
  const open = async (
    api: ReturnType<typeof anApi>,
    locale: Locale = 'en',
  ): Promise<Awaited<ReturnType<typeof renderApp>>> => {
    const view = await renderApp(<Outlet />, { path: '/sign-in', api, locale });
    await settle();
    return view;
  };

  test('GitHub only: the button, the password form and no link action', async () => {
    const view = await open(signedOut(false, true));
    expect(view.queryByRole('link', { name: GITHUB })).not.toBeNull();
    // The password is always there (R30): the setup's administrator has one on any server.
    expect(view.queryByRole('textbox', { name: 'Email address' })).not.toBeNull();
    expect(view.queryByLabelText('Password')).not.toBeNull();
    expect(view.queryByRole('button', { name: 'Sign in' })).not.toBeNull();
    expect(view.queryByRole('button', { name: 'Email me a sign-in link instead' })).toBeNull();
    expect(view.queryByText('This server is not set up yet')).toBeNull();
    view.unmount();
  });

  test('email only: no GitHub button, the password form and the link action under it', async () => {
    const view = await open(signedOut(true, false));
    expect(view.queryByRole('link', { name: GITHUB })).toBeNull();
    expect(view.queryByRole('textbox', { name: 'Email address' })).not.toBeNull();
    expect(view.queryByLabelText('Password')).not.toBeNull();
    expect(view.queryByRole('button', { name: 'Email me a sign-in link instead' })).not.toBeNull();
    expect(view.queryByText('This server is not set up yet')).toBeNull();
    // Alone, the form is the card's one way in: no rule to hang from, and Sign in is the primary one.
    const form = view.getByRole('form', { name: 'Sign in with a password' });
    expect(form.className).not.toContain('border-t-hairline');
    expect(view.getByRole('button', { name: 'Sign in' }).className).toContain('bg-accent');
    view.unmount();
  });

  test('both: the button and the form, parted by a rule', async () => {
    const view = await open(signedOut(true, true));
    expect(view.queryByRole('link', { name: GITHUB })).not.toBeNull();
    const form = view.getByRole('form', { name: 'Sign in with a password' });
    expect(form.className).toContain('border-t-hairline');
    expect(view.queryByRole('button', { name: 'Email me a sign-in link instead' })).not.toBeNull();
    view.unmount();
  });

  describe('single sign-on (D-200)', () => {
    const withOidc = (
      oidc: AuthMethods['oidc'],
      over: Partial<AuthMethods> = {},
    ): ReturnType<typeof anApi> =>
      anApi({
        me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
        authMethods: () =>
          Promise.resolve({ github: false, email: false, oidc, signUp: 'invite-only', ...over }),
      });

    for (const [locale, label] of [
      ['en', 'Continue with single sign-on'],
      ['tr', 'tek oturum açma ile devam et'],
    ] as const) {
      test(`a provider with no label of its own says single sign-on, in ${locale}, and leaves for /auth/oidc`, async () => {
        const view = await open(withOidc({ name: null }), locale);
        const button = view.getByRole('link', { name: label });
        expect(button.getAttribute('href')).toBe('/auth/oidc');
        // The server is set up: it has a way in, so it does not say it is waiting for its setup.
        expect(view.queryByText('This server is not set up yet')).toBeNull();
        view.unmount();
      });
    }

    test('the operator’s label is the button’s, shown as text and never as markup', async () => {
      const view = await open(withOidc({ name: 'Acme <b>SSO</b>' }));
      const button = view.getByRole('link', { name: 'Continue with Acme <b>SSO</b>' });
      expect(button.querySelector('b')).toBeNull();
      view.unmount();
    });

    test('beside GitHub both are offered, single sign-on first; with neither, none is', async () => {
      const view = await open(withOidc({ name: null }, { github: true }));
      const links = [...view.container.querySelectorAll('a[href^="/auth/"]')].map((a) =>
        a.getAttribute('href'),
      );
      expect(links).toEqual(['/auth/oidc', '/auth/github']);
      view.unmount();
      const none = await open(withOidc(null));
      expect(none.container.querySelector('a[href="/auth/oidc"]')).toBeNull();
      none.unmount();
    });

    test('with only single sign-on and mail, the form is not alone: a rule parts it from the button', async () => {
      const view = await open(withOidc({ name: null }, { email: true }));
      const form = view.getByRole('form', { name: 'Sign in with a password' });
      expect(form.className).toContain('border-t-hairline');
      view.unmount();
    });
  });

  test('a password manager is told which field is which', async () => {
    const view = await open(signedOut(false, false));
    expect(view.getByRole('textbox', { name: 'Email address' }).getAttribute('autocomplete')).toBe(
      'username',
    );
    expect(view.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
    view.unmount();
  });

  for (const [policy, expected] of [
    ['open', 'Create an account'],
    ['invite-only', 'Accounts are created by invitation.'],
  ] as const) {
    test(`under policy ${policy}: ${expected}`, async () => {
      const api = anApi({
        me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
        authMethods: () =>
          Promise.resolve({ github: true, email: true, oidc: null, signUp: policy }),
      });
      const view = await open(api);
      if (policy === 'open') {
        expect(view.getByRole('link', { name: expected }).getAttribute('href')).toBe('/sign-up');
      } else {
        expect(view.queryByText(expected)).not.toBeNull();
        expect(view.queryByRole('link', { name: 'Create an account' })).toBeNull();
      }
      view.unmount();
    });
  }

  for (const [locale, title, body, action] of [
    [
      'en',
      'This server is not set up yet',
      'Neither GitHub, single sign-on nor an emailed link is connected yet, but you can still sign in with a password. If you run this server, you can finish setting it up in the browser.',
      'Set up this server',
    ],
    [
      'tr',
      'Bu sunucu henüz kurulmadı',
      'GitHub ile giriş, tek oturum açma ve e-posta bağlantısı henüz bağlanmamış, ama parolanla yine de girebilirsin. Sunucuyu sen yönetiyorsan kurulumu tarayıcıdan tamamlayabilirsin.',
      'Bu sunucuyu kur',
    ],
  ] as const) {
    test(`neither: says plainly the server is not set up, in ${locale}, and offers the way to set it up above the password form`, async () => {
      const view = await open(signedOut(false, false), locale);
      expect(view.queryByRole('heading', { level: 2, name: title })).not.toBeNull();
      expect(view.queryByText(body)).not.toBeNull();
      expect(view.container.querySelector('a[href="/auth/github"]')).toBeNull();
      // The password form stays (R30); the way to the wizard is the one link.
      expect(view.queryByLabelText(locale === 'en' ? 'Password' : 'Parola')).not.toBeNull();
      // The way to the wizard (the address is the router's: `/setup`).
      expect(view.getByRole('link', { name: action }).getAttribute('href')).toBe('/setup');
      view.unmount();
    });
  }

  test('while the server has not said, nothing is offered and nothing is claimed; a failure to ask keeps the button and can be retried', async () => {
    let asked = 0;
    let answer: (methods: AuthMethods) => void = () => undefined;
    const pending = anApi({
      me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
      authMethods: () => {
        asked += 1;
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    const view = await renderApp(<Outlet />, { path: '/sign-in', api: pending });
    await settle();
    expect(view.queryByRole('status')).not.toBeNull();
    expect(view.queryByRole('link', { name: GITHUB })).toBeNull();
    expect(view.queryByText('This server is not set up yet')).toBeNull();
    await act(async () => {
      answer({ github: true, email: false, oidc: null, signUp: 'invite-only' });
      await Promise.resolve();
    });
    await settle();
    expect(view.queryByRole('link', { name: GITHUB })).not.toBeNull();
    expect(asked).toBe(1);
    view.unmount();

    let tries = 0;
    const failing = anApi({
      me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
      authMethods: () => {
        tries += 1;
        return tries === 1
          ? Promise.reject(new ApiError(404, 'ROUTE_NOT_FOUND', 'broke'))
          : Promise.resolve({ github: false, email: true, oidc: null, signUp: 'invite-only' });
      },
    });
    const again = await renderApp(<Outlet />, { path: '/sign-in', api: failing });
    await settle();
    // The historical default: the button stays (the server answers a defined 404 for one that should
    // not have been offered), the form stays hidden, and a small line says the check failed (R45).
    expect(again.queryByRole('link', { name: GITHUB })).not.toBeNull();
    expect(again.queryByRole('button', { name: 'Email me a sign-in link instead' })).toBeNull();
    expect(
      again.queryByText('We could not check which sign‑in options this server offers.'),
    ).not.toBeNull();
    expect(again.queryByText('This server is not set up yet')).toBeNull();
    await act(async () => {
      again.getByRole('button', { name: 'Try again' }).click();
      await Promise.resolve();
    });
    await settle();
    // Asked again, the server's word is what the screen offers: email only, and the line is gone.
    expect(again.queryByRole('link', { name: GITHUB })).toBeNull();
    expect(again.queryByRole('button', { name: 'Email me a sign-in link instead' })).not.toBeNull();
    expect(again.queryByText(/could not check which sign‑in options/)).toBeNull();
    again.unmount();
  });

  test('a hiccup that mends itself is retried by the query, and the person never sees the line', async () => {
    let tries = 0;
    const hiccup = anApi({
      me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
      authMethods: () => {
        tries += 1;
        return tries === 1
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve({ github: true, email: false, oidc: null, signUp: 'invite-only' });
      },
    });
    const view = await renderApp(<Outlet />, { path: '/sign-in', api: hiccup });
    // The first retry waits a short, fixed time (`AUTH_METHODS_RETRY_MS`), not the client's default.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
    });
    await settle();
    expect(tries).toBe(2);
    expect(view.queryByRole('link', { name: GITHUB })).not.toBeNull();
    expect(view.queryByText(/could not check which sign‑in options/)).toBeNull();
    view.unmount();
  });
});

describe('signing in for the native application (D-191)', () => {
  const hold = (age = 0): void => {
    window.sessionStorage.setItem(
      'purlay.native',
      JSON.stringify({
        challenge: 'a'.repeat(43),
        state: 'b'.repeat(22),
        at: systemClock.now().getTime() - age,
      }),
    );
  };
  const visit = async (locale: Locale): Promise<Awaited<ReturnType<typeof renderApp>>> => {
    const view = await renderApp(<Outlet />, { path: '/sign-in', api: signedOut(false), locale });
    await settle();
    return view;
  };

  test('says what the person is signing in for, so the page is not a stranger’s', async () => {
    hold();
    try {
      const view = await visit('en');
      expect(view.getByText('Sign in to continue to Purlay for Mac.')).toBeDefined();
    } finally {
      window.sessionStorage.clear();
    }
  });

  test('says it in Turkish for a person who reads that', async () => {
    hold();
    try {
      const view = await visit('tr');
      expect(view.getByText('Purlay for Mac’e devam etmek için giriş yap.')).toBeDefined();
    } finally {
      window.sessionStorage.clear();
    }
  });

  test('says nothing of the kind where the tab holds no question, or one gone stale', async () => {
    expect((await visit('en')).queryByText(/Purlay for Mac/)).toBeNull();
    hold(11 * 60_000);
    try {
      expect((await visit('en')).queryByText(/Purlay for Mac/)).toBeNull();
    } finally {
      window.sessionStorage.clear();
    }
  });
});
