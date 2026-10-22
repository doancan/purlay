/**
 * `/sign-up` (R51): where anybody may make an account it offers GitHub and a link by email — no
 * password — and where sign-up is by invitation it says so and points to sign-in.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { AuthMethods, EmailSignInRequest } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { en } from '../../i18n/catalogue/en';
import { installDom } from '../../testing/dom';
import { aSession } from '../../testing/fixtures';
import { anApi } from '../../testing/fake-api';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import type { Locale } from '../../i18n/types';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const visit = async (
  methods: AuthMethods,
  locale: Locale = 'en',
  asked: EmailSignInRequest[] = [],
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, {
    path: '/sign-up',
    locale,
    api: anApi({
      me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
      authMethods: () => Promise.resolve(methods),
      requestEmailSignIn: (input) => {
        asked.push(input);
        return Promise.resolve();
      },
    }),
  });
  await settle();
  return view;
};

describe('the sign-up screen', () => {
  test('open, with GitHub and mail: both ways, no password, and a way back to sign-in', async () => {
    const asked: EmailSignInRequest[] = [];
    const view = await visit({ github: true, email: true, signUp: 'open' }, 'en', asked);
    expect(view.getByRole('heading', { level: 1, name: 'Create your account' })).toBeDefined();
    expect(view.getByRole('link', { name: 'Continue with GitHub' }).getAttribute('href')).toBe(
      '/auth/github',
    );
    expect(view.queryByLabelText('Password')).toBeNull();
    await expectNoAxeViolations(view.container);
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'Email address' }), 'new@example.test');
    await user.click(view.getByRole('button', { name: 'Email me a sign-in link' }));
    await settle();
    expect(asked).toEqual([{ email: 'new@example.test', locale: 'en' }]);
    view.unmount();
    const again = await visit({ github: true, email: true, signUp: 'open' });
    expect(again.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/sign-in');
  });

  test('open without mail: GitHub only, and no form', async () => {
    const view = await visit({ github: true, email: false, signUp: 'open' });
    expect(view.queryByRole('link', { name: 'Continue with GitHub' })).not.toBeNull();
    expect(view.queryByRole('textbox')).toBeNull();
  });

  test('open with neither: says there is no way to sign up yet', async () => {
    const view = await visit({ github: false, email: false, signUp: 'open' });
    expect(
      view.queryByText('This server has no way to make an account connected yet.'),
    ).not.toBeNull();
    expect(view.queryByRole('textbox')).toBeNull();
  });

  for (const [locale, title, body, link] of [
    [
      'en',
      'Accounts are created by invitation',
      'This Purlay server does not take sign-ups. Ask someone on it for an invitation link, and open the link to make your account.',
      'Sign in',
    ],
    [
      'tr',
      'Hesaplar davetle açılır',
      'Bu Purlay sunucusu kendiliğinden kayıt almıyor. Sunucudaki birinden davet bağlantısı iste ve hesabını o bağlantıyı açarak oluştur.',
      'Giriş yap',
    ],
  ] as const) {
    test(`invite-only: the notice in ${locale}, with the sign-in link and no form or button`, async () => {
      const view = await visit({ github: true, email: true, signUp: 'invite-only' }, locale);
      expect(view.getByRole('heading', { level: 1, name: title })).toBeDefined();
      expect(view.queryByText(body)).not.toBeNull();
      expect(view.getByRole('link', { name: link }).getAttribute('href')).toBe('/sign-in');
      expect(view.queryByRole('textbox')).toBeNull();
      expect(view.container.querySelector('a[href="/auth/github"]')).toBeNull();
      await expectNoAxeViolations(view.container);
    });
  }
});

describe('the sign-up screen, before the server has said what it offers', () => {
  test('says it could not check, and asks again when told to, then shows the answer', async () => {
    let calls = 0;
    const view = await renderApp(<Outlet />, {
      path: '/sign-up',
      api: anApi({
        me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
        authMethods: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new ApiError(404, 'ROUTE_NOT_FOUND', 'no'))
            : Promise.resolve({ github: true, email: false, signUp: 'open' });
        },
      }),
    });
    await settle();
    expect(view.getByText(en['signIn.methods.unchecked'])).toBeDefined();
    expect(view.queryByRole('link', { name: 'Continue with GitHub' })).toBeNull();
    await person().click(view.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(calls).toBe(2);
    expect(view.getByRole('link', { name: 'Continue with GitHub' })).toBeDefined();
  });

  test('shows a loading state while the answer is on its way', async () => {
    const view = await renderApp(<Outlet />, {
      path: '/sign-up',
      api: anApi({
        me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
        authMethods: () => new Promise<AuthMethods>(() => undefined),
      }),
    });
    await settle();
    expect(view.getByRole('status')).toBeDefined();
    expect(view.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });

  test('sends a person who is already signed in home, not to a form', async () => {
    const view = await renderApp(<Outlet />, {
      path: '/sign-up',
      api: anApi({
        me: () => Promise.resolve(aSession()),
        authMethods: () => Promise.resolve({ github: true, email: true, signUp: 'open' }),
      }),
    });
    await settle();
    expect(view.world.history.stack.at(-1)).not.toBe('/sign-up');
    expect(view.queryByRole('heading', { name: 'Create your account' })).toBeNull();
  });
});
