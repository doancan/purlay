/**
 * How a person gets to the wizard: `/` on a server nobody has set up, and the sign-in card's own
 * "not set up yet" link — and that a server already set up sends `/` to sign-in as it always did.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { renderApp } from '../../testing/render';
import { settle } from './testing';

installDom();

const signedOut = (open: boolean, calls: { status: number }): ReturnType<typeof anApi> =>
  anApi({
    me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
    setupStatus: () => {
      calls.status += 1;
      return Promise.resolve({ open, appUrl: 'https://purlay.test' });
    },
    authMethods: () =>
      Promise.resolve({
        github: false,
        email: false,
        oidc: null,
        signUp: 'invite-only',
        password: true,
      }),
  });

/** The wizard's chunk, once `/setup` is reached, reads the real network: here there is none. */
let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
beforeEach(() => {
  network = spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('offline'));
});
afterEach(() => {
  network.mockRestore();
});

describe('the front door of a server', () => {
  test('goes to the wizard when nobody is signed in and the server is open to setup', async () => {
    const calls = { status: 0 };
    const view = await renderApp(<Outlet />, { path: '/', api: signedOut(true, calls) });
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/setup');
    expect(calls.status).toBe(1);
  });

  test('goes to sign-in when the server is set up', async () => {
    const view = await renderApp(<Outlet />, { path: '/', api: signedOut(false, { status: 0 }) });
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/sign-in');
  });

  test('goes to sign-in when the status could not be read', async () => {
    const api = anApi({
      me: () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
      setupStatus: () => Promise.reject(new ApiError(429, 'RATE_LIMITED', 'slow')),
    });
    const view = await renderApp(<Outlet />, { path: '/', api });
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/sign-in');
  });

  test('does not ask whether setup is open from any other address', async () => {
    const calls = { status: 0 };
    await renderApp(<Outlet />, { path: '/sign-in', api: signedOut(true, calls) });
    await settle();
    expect(calls.status).toBe(0);
  });
});

describe('the sign-in card of a server with no way in', () => {
  for (const [locale, name] of [
    ['en', 'Set up this server'],
    ['tr', 'Bu sunucuyu kur'],
  ] as const) {
    test(`links to the wizard in ${locale}`, async () => {
      const view = await renderApp(<Outlet />, {
        path: '/sign-in',
        api: signedOut(true, { status: 0 }),
        locale,
      });
      await settle();
      expect(view.getByRole('link', { name }).getAttribute('href')).toBe('/setup');
    });
  }
});
