/**
 * The address link's page (`API.md` §2, D-179 §4.3): the token is read from the fragment once, leaves
 * the address bar, is posted once, and the page says verified or refused — with no claim and no session.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { SetupFailure } from './client';
import { aClient, settle } from './testing';
import { readVerifyLink, VerifyScreen } from './verify-screen';

installDom();

const TOKEN = 'a1'.repeat(32);

const open = async (
  hash: string,
  verify: (token: string) => Promise<{ readonly verified: true }>,
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  window.history.replaceState(null, '', `/setup/verify${hash}`);
  const view = await renderApp(<VerifyScreen client={aClient({ verify })} />, {
    path: '/setup/verify',
  });
  await settle();
  return view;
};

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the address link', () => {
  test('reads a token of 64 hex characters, and nothing else', () => {
    expect(readVerifyLink(`#${TOKEN}`)).toBe(TOKEN);
    for (const hash of ['', '#', `#${TOKEN}x`, `#${TOKEN.toUpperCase()}`, `#${TOKEN.slice(1)}`]) {
      expect(readVerifyLink(hash)).toBeNull();
    }
  });

  test('posts the token once, takes it out of the address, and says it is verified', async () => {
    const posted: string[] = [];
    const view = await open(`#${TOKEN}`, (token) => {
      posted.push(token);
      return Promise.resolve({ verified: true });
    });
    expect(posted).toEqual([TOKEN]);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/setup/verify');
    expect(view.getByRole('heading', { name: 'Your address is verified' })).toBeDefined();
  });

  test('says a link that does not open is one sentence', async () => {
    const view = await open(`#${TOKEN}`, () =>
      Promise.reject(new SetupFailure(404, 'ADMIN_LINK_NOT_FOUND', 'no')),
    );
    expect(view.getByRole('heading', { name: 'This link does not open' })).toBeDefined();
    expect(view.getByText(/a link works once, for 24 hours/)).toBeDefined();
  });

  test('says an incomplete link is incomplete, and posts nothing', async () => {
    let posted = 0;
    const view = await open('#nothing', () => {
      posted += 1;
      return Promise.resolve({ verified: true });
    });
    expect(view.getByRole('heading', { name: 'This link is incomplete' })).toBeDefined();
    expect(posted).toBe(0);
  });

  test('offers a retry when the server could not be reached', async () => {
    const view = await open(`#${TOKEN}`, () =>
      Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
    );
    expect(view.getByRole('heading', { name: 'Could not verify the address' })).toBeDefined();
    expect(view.getByRole('button', { name: 'Retry' })).toBeDefined();
  });
});

describe('the address link, when the server will not answer yet', () => {
  test('says how many minutes to wait when it was asked to slow down', async () => {
    const view = await open(`#${TOKEN}`, () =>
      Promise.reject(new SetupFailure(429, 'RATE_LIMITED', 'slow', 150)),
    );
    expect(view.getByRole('heading', { name: 'Could not verify the address' })).toBeDefined();
    expect(view.getByText(/3 minutes/)).toBeDefined();
  });
});
