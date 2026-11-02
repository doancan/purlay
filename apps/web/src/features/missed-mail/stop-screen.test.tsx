/**
 * A missed-mail letter's stop link, opened (D-240): the token leaves the address, nothing is spent until the
 * person presses the button, and each answer — stopped, a link that does not open, a failure with the way to
 * try again, no token at all — is said, in both languages, with focus on what replaced the question.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { readStopLink } from './stop-screen';

installDom();

const TOKEN = 'b'.repeat(64);

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const open = async (
  fragment: string,
  api: Partial<Api>,
  locale: 'en' | 'tr' = 'en',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  window.history.replaceState(null, '', `/mail/stop${fragment}`);
  const view = await renderApp(<Outlet />, { path: '/mail/stop', api: anApi(api), locale });
  await settle();
  return view;
};

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('a stop link, opened', () => {
  test('reads a token and nothing else', () => {
    expect(readStopLink(`#${TOKEN}`)).toBe(TOKEN);
    for (const hash of ['', '#', `#${TOKEN.slice(1)}`, `#${TOKEN.toUpperCase()}`, `#${TOKEN}x`]) {
      expect(readStopLink(hash)).toBeNull();
    }
  });

  test('takes the token out of the address, spends nothing on load, and stops the letters on the button', async () => {
    const stopped: string[] = [];
    const view = await open(`#${TOKEN}`, {
      stopMissedMail: async (token) => {
        stopped.push(token);
        await Promise.resolve();
      },
    });
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/mail/stop');
    expect(view.getByRole('heading', { level: 1, name: 'Stop these emails?' })).toBeDefined();
    expect(stopped).toEqual([]);
    await expectNoAxeViolations(view.container);

    await person().click(view.getByRole('button', { name: 'Stop these emails' }));
    await settle();
    expect(stopped).toEqual([TOKEN]);
    const done = view.getByRole('heading', {
      level: 1,
      name: 'You won’t get these emails any more',
    });
    expect(done.closest('[tabindex="-1"]')).toBe(document.activeElement);
    expect(view.getByRole('link', { name: 'Open Purlay' }).getAttribute('href')).toBe('/');
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a link that does not open says so; a failure says why and the button tries again', async () => {
    const refused = await open(`#${TOKEN}`, {
      stopMissedMail: () => Promise.reject(new ApiError(404, 'MAIL_LINK_NOT_FOUND', 'no')),
    });
    await person().click(refused.getByRole('button', { name: 'Stop these emails' }));
    await settle();
    expect(
      refused.getByRole('heading', { level: 1, name: 'This link does not open' }),
    ).toBeDefined();
    refused.unmount();

    let asked = 0;
    const failing = await open(`#${TOKEN}`, {
      stopMissedMail: () => {
        asked += 1;
        return asked === 1
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'no'))
          : Promise.resolve();
      },
    });
    await person().click(failing.getByRole('button', { name: 'Stop these emails' }));
    await settle();
    expect(failing.getByText(/^The emails were not stopped\./)).toBeDefined();
    await person().click(failing.getByRole('button', { name: 'Stop these emails' }));
    await settle();
    expect(
      failing.getByRole('heading', { level: 1, name: 'You won’t get these emails any more' }),
    ).toBeDefined();
    failing.unmount();
  });

  test('without a token it says the link is not complete, in Turkish too', async () => {
    const view = await open('', {}, 'tr');
    expect(view.getByRole('heading', { level: 1, name: 'Bu bağlantı eksik' })).toBeDefined();
    expect(view.queryByRole('button')).toBeNull();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });
});
