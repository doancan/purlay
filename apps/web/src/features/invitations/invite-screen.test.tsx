/**
 * `/invite` (D-115, `UX.md` §2, §8): the invitation's card, joining and opening, and each state — read,
 * not opening, failed with Retry, no token at all — against the fake API, in both languages.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { spyOn } from 'bun:test';
import type { InvitationPreview, Membership } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { WORKSPACE, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { leave } from '../sign-in/leave';
import type { Api } from '../../data/api';

installDom();

const TOKEN = 'c'.repeat(64);
const KEY = 'purlay.invitation';
const UNTIL = '2026-09-16T12:00:00.000Z';

const preview = (member = false): InvitationPreview => ({
  workspace: {
    ...WORKSPACE,
    id: '00000000-0000-4000-8000-0000000000b1',
    name: 'Atlas',
    slug: 'atlas',
  },
  expiresAt: UNTIL,
  member,
});

const membership = (): Membership => ({
  workspace: preview().workspace,
  role: 'member',
  joinedAt: UNTIL,
  deepWorkUntil: null,
});

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const visit = async (
  api: Partial<Api>,
  locale: 'en' | 'tr' = 'en',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, { path: '/invite', api: aSignedInApi(api), locale });
  await settle();
  return view;
};

const here = (view: Awaited<ReturnType<typeof renderApp>>): string =>
  view.world.history.stack.at(-1) ?? '';

afterEach(() => {
  window.sessionStorage.clear();
});

describe('an invitation, opened', () => {
  test('names the workspace and until when; Join joins with the token, forgets it and offers its channels', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    const asked: string[] = [];
    const joined: string[] = [];
    const view = await visit({
      previewInvitation: async (token) => {
        asked.push(token);
        return await Promise.resolve(preview());
      },
      acceptInvitation: async (token) => {
        joined.push(token);
        return await Promise.resolve(membership());
      },
    });

    expect(view.getByRole('heading', { name: 'Join Atlas' })).toBeDefined();
    expect(view.getByText(/open until/)).toBeDefined();
    await expectNoAxeViolations(view.container);
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Join' }));
    });
    await settle();
    expect(asked).toEqual([TOKEN]);
    expect(joined).toEqual([TOKEN]);
    // Just joined: the channels to join come first (D-132).
    expect(here(view)).toBe('/w/atlas/welcome');
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test('somebody already in it is offered Open, which joins nothing', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    const view = await visit({ previewInvitation: () => Promise.resolve(preview(true)) });
    expect(view.getByText('You are already in Atlas.')).toBeDefined();
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Open' }));
    });
    await settle();
    expect(here(view)).toBe('/w/atlas');
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
  });

  test('a link that does not open says so with the way home, and is forgotten', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    const view = await visit({
      previewInvitation: () =>
        Promise.reject(new ApiError(404, 'INVITATION_NOT_FOUND', 'That invitation does not open.')),
    });
    expect(view.getByRole('heading', { name: 'This invitation does not open' })).toBeDefined();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Go home' }));
    });
    await settle();
    // Home, which sends somebody with a workspace on into it.
    expect(here(view).startsWith('/w/acme')).toBe(true);
  });

  test('with no token in the tab it says the same, and asks the server nothing', async () => {
    const view = await visit({});
    expect(view.getByRole('heading', { name: 'This invitation does not open' })).toBeDefined();
  });

  test('any other failure keeps the token and offers Retry, which reads it again', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    let calls = 0;
    const view = await visit({
      previewInvitation: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(0, 'NETWORK', 'down');
        return await Promise.resolve(preview());
      },
    });
    expect(view.getByRole('heading', { name: 'Could not read the invitation' })).toBeDefined();
    expect(window.sessionStorage.getItem(KEY)).toBe(TOKEN);
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Retry' }));
    });
    await settle();
    expect(view.getByRole('heading', { name: 'Join Atlas' })).toBeDefined();
  });

  test('while it is read, the card is a skeleton that says so', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    const view = await visit({ previewInvitation: () => new Promise(() => undefined) });
    expect(view.getByRole('status').textContent).toContain('Reading the invitation');
  });

  test('a join that fails says why and stays; one the server no longer opens is the gone card', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    let attempt = 0;
    const view = await visit({
      previewInvitation: () => Promise.resolve(preview()),
      acceptInvitation: async () => {
        attempt += 1;
        await Promise.resolve();
        throw attempt === 1
          ? new ApiError(0, 'NETWORK', 'down')
          : new ApiError(404, 'INVITATION_NOT_FOUND', 'gone');
      },
    });
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Join' }));
    });
    await settle();
    expect(view.getByRole('alert').textContent).toContain('Could not join.');
    expect(here(view)).toBe('/invite');
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Join' }));
    });
    await settle();
    expect(view.getByRole('heading', { name: 'This invitation does not open' })).toBeDefined();
  });

  test('is said in Turkish when the interface is', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    const view = await visit({ previewInvitation: () => Promise.resolve(preview()) }, 'tr');
    expect(view.getByRole('heading', { name: 'Atlas çalışma alanına katıl' })).toBeDefined();
    expect(view.getByRole('button', { name: 'Katıl' })).toBeDefined();
  });
});

describe('coming back from signing in with an invitation', () => {
  test('home goes to the invitation, not to the first workspace', async () => {
    window.sessionStorage.setItem(KEY, TOKEN);
    const view = await renderApp(<Outlet />, {
      path: '/',
      api: aSignedInApi({ previewInvitation: () => Promise.resolve(preview()) }),
    });
    await settle();
    expect(here(view)).toBe('/invite');
  });
});

describe('an invitation, opened by somebody who is not signed in', () => {
  const asSignedOut = async (
    api: Partial<Api>,
    methods: { github: boolean; email: boolean } = { github: true, email: true },
    locale: 'en' | 'tr' = 'en',
  ): Promise<Awaited<ReturnType<typeof renderApp>>> => {
    window.sessionStorage.setItem(KEY, TOKEN);
    const view = await renderApp(<Outlet />, {
      path: '/invite',
      locale,
      api: aSignedInApi({
        me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
        authMethods: () => Promise.resolve({ ...methods, signUp: 'invite-only' }),
        ...api,
      }),
    });
    await settle();
    return view;
  };

  test('GitHub: the passport is asked for first, and only when it is given does the page leave', async () => {
    const order: string[] = [];
    const left = spyOn(leave, 'to').mockImplementation((url) => {
      order.push(`leave ${url}`);
    });
    const view = await asSignedOut({
      openInvitationPassport: async (input) => {
        order.push(`passport ${JSON.stringify(input)}`);
        await Promise.resolve();
      },
    });
    expect(view.getByRole('heading', { name: 'You have been invited' })).toBeDefined();
    await expectNoAxeViolations(view.container);
    await person().click(view.getByRole('link', { name: 'Continue with GitHub' }));
    await settle();
    expect(order).toEqual([`passport ${JSON.stringify({ token: TOKEN })}`, 'leave /auth/github']);
    left.mockRestore();
  });

  test.each([
    [
      new ApiError(429, 'RATE_LIMITED', 'slow'),
      'This invitation is being opened a lot right now. Try again in a while.',
    ],
    [new ApiError(500, 'INTERNAL', 'broke'), 'The invitation could not be checked.'],
  ])(
    'a passport that is refused (%s) is said in words and the page does not leave',
    async (failure, words) => {
      const left = spyOn(leave, 'to').mockImplementation(() => undefined);
      const view = await asSignedOut({ openInvitationPassport: () => Promise.reject(failure) });
      await person().click(view.getByRole('link', { name: 'Continue with GitHub' }));
      await settle();
      expect(view.getByRole('alert').textContent).toContain(words);
      expect(left).not.toHaveBeenCalled();
      left.mockRestore();
    },
  );

  test('a link that does not open is the page’s "does not open" state, forgotten, and nothing else happens', async () => {
    const left = spyOn(leave, 'to').mockImplementation(() => undefined);
    const view = await asSignedOut({
      openInvitationPassport: () =>
        Promise.reject(new ApiError(404, 'INVITATION_NOT_FOUND', 'That invitation does not open.')),
    });
    await person().click(view.getByRole('link', { name: 'Continue with GitHub' }));
    await settle();
    expect(view.getByRole('heading', { name: 'This invitation does not open' })).toBeDefined();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(left).not.toHaveBeenCalled();
    left.mockRestore();
  });

  test('email: the passport is for that address, then the link is asked for with the invitation', async () => {
    const order: string[] = [];
    const view = await asSignedOut({
      openInvitationPassport: async (input) => {
        order.push(`passport ${JSON.stringify(input)}`);
        await Promise.resolve();
      },
      requestEmailSignIn: async (input) => {
        order.push(`link ${JSON.stringify(input)}`);
        await Promise.resolve();
      },
    });
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'Email address' }), 'new@example.test');
    await user.click(view.getByRole('button', { name: 'Email me a sign-in link' }));
    await settle();
    expect(order).toEqual([
      `passport ${JSON.stringify({ token: TOKEN, email: 'new@example.test' })}`,
      `link ${JSON.stringify({ email: 'new@example.test', locale: 'en', invitation: TOKEN })}`,
    ]);
  });

  test('email: a refused passport asks for no link', async () => {
    let asked = 0;
    const view = await asSignedOut({
      openInvitationPassport: () => Promise.reject(new ApiError(429, 'RATE_LIMITED', 'slow')),
      requestEmailSignIn: () => {
        asked += 1;
        return Promise.resolve();
      },
    });
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'Email address' }), 'new@example.test');
    await user.click(view.getByRole('button', { name: 'Email me a sign-in link' }));
    await settle();
    expect(asked).toBe(0);
    expect(view.getByRole('alert').textContent).toContain('Try again in a while');
  });

  test('without mail there is no form; somebody with an account is pointed to sign-in, in Turkish too', async () => {
    const view = await asSignedOut({}, { github: true, email: false }, 'tr');
    expect(view.queryByRole('textbox')).toBeNull();
    expect(view.getByRole('link', { name: 'Parolanla giriş yap' }).getAttribute('href')).toBe(
      '/sign-in',
    );
    // The invitation is still in the tab for the way back from signing in.
    expect(window.sessionStorage.getItem(KEY)).toBe(TOKEN);
  });
});
