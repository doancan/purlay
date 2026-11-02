/**
 * Where you are signed in (D-193), on the Sessions & account page through the real frame: each session
 * named as the server names it, this one marked and not offered, and signing another out — taken off at
 * once, put back and said when refused.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import type { DeviceSession, DeviceSessionList } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import type { Locale } from '../../../i18n/types';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';

installDom();

type Scope = BoundFunctions<typeof queries>;
type View = Awaited<ReturnType<typeof renderApp>>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const HERE: DeviceSession = {
  id: '0199a000-0000-7000-8000-000000000001',
  kind: 'browser',
  name: null,
  createdAt: '2026-09-09T08:00:00.000Z',
  lastUsedAt: '2026-09-12T10:00:00.000Z',
  expiresAt: '2026-10-09T08:00:00.000Z',
  current: true,
};
const MAC: DeviceSession = {
  id: '0199a000-0000-7000-8000-000000000002',
  kind: 'native',
  name: 'Doğan’s MacBook Pro',
  createdAt: '2026-09-01T07:30:00.000Z',
  lastUsedAt: '2026-09-11T15:00:00.000Z',
  expiresAt: '2026-10-01T07:30:00.000Z',
  current: false,
};
const OTHER_BROWSER: DeviceSession = {
  id: '0199a000-0000-7000-8000-000000000003',
  kind: 'browser',
  name: null,
  createdAt: '2026-08-20T09:00:00.000Z',
  lastUsedAt: '2026-09-02T09:00:00.000Z',
  expiresAt: '2026-09-20T09:00:00.000Z',
  current: false,
};

/** What the server holds: `GET` answers it, and a `DELETE` that the test lets through takes from it. */
const held = (...sessions: DeviceSession[]): { sessions: DeviceSession[] } => ({ sessions });

const open = async (
  api: Partial<Api>,
  locale: Locale = 'en',
): Promise<{ view: View; card: Scope }> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    { path: '/w/acme/settings/account', api: aSignedInApi(api), locale },
  );
  await settle();
  const english = locale === 'en';
  await view.findByRole('heading', {
    level: 1,
    name: english ? 'Sessions & account' : 'Oturumlar ve hesap',
  });
  const region = view.getByRole('region', {
    name: english ? 'Where you are signed in' : 'Oturum açık olan yerler',
  });
  return { view, card: within(region) };
};

const rows = (card: Scope): HTMLElement[] =>
  within(card.getByRole('list', { name: 'Signed-in devices' })).getAllByRole('listitem');

/** One row of the list, by its place in it. */
const row = (card: Scope, index: number): Scope => {
  const found = rows(card)[index];
  if (found === undefined) throw new Error(`no row ${String(index)}`);
  return within(found);
};

describe('the list', () => {
  test('names each session as the server does, marks this one, and offers Sign out on the others alone', async () => {
    const server = held(HERE, MAC, OTHER_BROWSER);
    const { view, card } = await open({
      mySessions: () => Promise.resolve({ data: server.sessions }),
    });
    await card.findByText('Doğan’s MacBook Pro');
    expect(rows(card)).toHaveLength(3);
    const [here, mac, browser] = [row(card, 0), row(card, 1), row(card, 2)];

    // This browser: marked, when it was signed in, and nothing to press.
    expect(here.getByText('Web browser')).toBeDefined();
    expect(here.getByText('This device')).toBeDefined();
    expect(here.getByText(/^Signed in Sep 9, 2026\D+8:00\sAM$/)).toBeDefined();
    expect(here.queryByText(/Last active/)).toBeNull();
    expect(here.queryByRole('button')).toBeNull();

    // The Mac by the name it sent; another browser by its dates, never by a guess at what it is.
    expect(mac.getByText(/^Last active Sep 11, 2026\D+3:00\sPM$/)).toBeDefined();
    expect(mac.queryByText('This device')).toBeNull();
    expect(browser.getByText('Web browser')).toBeDefined();
    expect(browser.getByText(/^Signed in Aug 20, 2026\D+9:00\sAM$/)).toBeDefined();

    // Each Sign out says, to a screen reader, which device it ends.
    const buttons = card.getAllByRole('button', { name: 'Sign out' });
    expect(buttons).toHaveLength(2);
    const describedBy = buttons.map(
      (button) =>
        view.container.ownerDocument.getElementById(button.getAttribute('aria-describedby') ?? '')
          ?.textContent,
    );
    expect(describedBy[0]).toMatch(/^Doğan’s MacBook ProSigned in .+Last active .+/);
    expect(describedBy[1]).toMatch(/^Web browserSigned in Aug 20/);
    expect(card.queryByText('You are not signed in anywhere else.')).toBeNull();
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test('a Mac that sent no name is called Purlay for Mac', async () => {
    const { view, card } = await open({
      mySessions: () => Promise.resolve({ data: [HERE, { ...MAC, name: null }] }),
    });
    expect(await card.findByText('Purlay for Mac')).toBeDefined();
    view.unmount();
  });

  test('in Turkish, the words are Turkish and the device’s own name is left as it is', async () => {
    const { view, card } = await open(
      { mySessions: () => Promise.resolve({ data: [HERE, MAC] }) },
      'tr',
    );
    await card.findByText('Doğan’s MacBook Pro');
    expect(card.getByText('Bu cihaz')).toBeDefined();
    expect(card.getByText('Web tarayıcısı')).toBeDefined();
    expect(card.getAllByText(/^Oturum açılışı: /)).toHaveLength(2);
    expect(card.getByRole('button', { name: 'Çıkış yap' })).toBeDefined();
    view.unmount();
  });

  test('signed in here alone, it says nowhere else is', async () => {
    const { view, card } = await open({ mySessions: () => Promise.resolve({ data: [HERE] }) });
    expect(await card.findByText('You are not signed in anywhere else.')).toBeDefined();
    expect(rows(card)).toHaveLength(1);
    expect(card.queryByRole('button')).toBeNull();
    view.unmount();
  });

  test('an answer with no session at all still says so, and offers nothing', async () => {
    const { view, card } = await open({ mySessions: () => Promise.resolve({ data: [] }) });
    expect(await card.findByText('You are not signed in anywhere else.')).toBeDefined();
    expect(card.queryByRole('button')).toBeNull();
    view.unmount();
  });

  test('while it is read, the card says so', async () => {
    const { view, card } = await open({ mySessions: () => new Promise(() => undefined) });
    expect(card.getByRole('status').textContent).toBe('Loading');
    expect(card.queryByRole('list')).toBeNull();
    view.unmount();
  });

  test('a failure to read it is said, with Retry, which reads it again', async () => {
    let fail = true;
    const { view, card } = await open({
      mySessions: () =>
        fail
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'x'))
          : Promise.resolve({ data: [HERE, MAC] }),
    });
    expect(await card.findByText(/^Could not read where you are signed in\./)).toBeDefined();
    fail = false;
    await person().click(card.getByRole('button', { name: 'Retry' }));
    expect(await card.findByText('Doğan’s MacBook Pro')).toBeDefined();
    view.unmount();
  });
});

describe('signing another device out', () => {
  /** A server whose `DELETE` waits for the test to answer it. */
  const pending = (server: {
    sessions: DeviceSession[];
  }): {
    api: Partial<Api>;
    ended: string[];
    reads: () => number;
    answer: (outcome: 'ok' | ApiError) => Promise<void>;
  } => {
    const ended: string[] = [];
    let reads = 0;
    let settleDelete: ((outcome: 'ok' | ApiError) => void) | null = null;
    return {
      ended,
      reads: () => reads,
      api: {
        mySessions: (): Promise<DeviceSessionList> => {
          reads += 1;
          return Promise.resolve({ data: [...server.sessions] });
        },
        endMySession: (sessionId): Promise<void> => {
          ended.push(sessionId);
          return new Promise<void>((resolve, reject) => {
            settleDelete = (outcome): void => {
              if (outcome === 'ok') {
                server.sessions = server.sessions.filter((each) => each.id !== sessionId);
                resolve();
              } else reject(outcome);
            };
          });
        },
      },
      answer: async (outcome): Promise<void> => {
        settleDelete?.(outcome);
        await settle();
      },
    };
  };

  test('is taken off at once, then said, and the list is read again from the server', async () => {
    const server = held(HERE, MAC, OTHER_BROWSER);
    const fake = pending(server);
    const { view, card } = await open(fake.api);
    await card.findByText('Doğan’s MacBook Pro');
    const before = fake.reads();

    await person().click(
      within(
        card.getByText('Doğan’s MacBook Pro').closest('li') ?? card.getByRole('list'),
      ).getByRole('button', { name: 'Sign out' }),
    );
    // Before the server answers: gone from the list, and focus on what is left rather than on nothing.
    expect(card.queryByText('Doğan’s MacBook Pro')).toBeNull();
    expect(fake.ended).toEqual([MAC.id]);
    expect(view.container.ownerDocument.activeElement).toBe(
      card.getByRole('list', { name: 'Signed-in devices' }),
    );

    await fake.answer('ok');
    expect(view.getByText('Doğan’s MacBook Pro was signed out.')).toBeDefined();
    expect(fake.reads()).toBeGreaterThan(before);
    expect(rows(card)).toHaveLength(2);
    expect(card.queryByText('Doğan’s MacBook Pro')).toBeNull();
    view.unmount();
  });

  test('the last other one gone, it says nowhere else is', async () => {
    const fake = pending(held(HERE, OTHER_BROWSER));
    const { view, card } = await open(fake.api);
    await person().click(await card.findByRole('button', { name: 'Sign out' }));
    expect(card.getByText('You are not signed in anywhere else.')).toBeDefined();
    await fake.answer('ok');
    expect(view.getByText('Web browser was signed out.')).toBeDefined();
    expect(card.getByText('You are not signed in anywhere else.')).toBeDefined();
    view.unmount();
  });

  test('refused, it is put back and the refusal is said', async () => {
    const fake = pending(held(HERE, MAC));
    const { view, card } = await open(fake.api);
    await person().click(await card.findByRole('button', { name: 'Sign out' }));
    expect(card.queryByText('Doğan’s MacBook Pro')).toBeNull();

    await fake.answer(new ApiError(429, 'RATE_LIMITED', 'slow down'));
    expect(await card.findByText('Doğan’s MacBook Pro')).toBeDefined();
    expect(view.getByText(/^Doğan’s MacBook Pro was not signed out\. .+/)).toBeDefined();
    expect(card.getByRole('button', { name: 'Sign out' })).toBeDefined();
    view.unmount();
  });

  test('not reached at all, it is put back and said the same way', async () => {
    const fake = pending(held(HERE, MAC));
    const { view, card } = await open(fake.api);
    await person().click(await card.findByRole('button', { name: 'Sign out' }));
    await fake.answer(new ApiError(0, 'NETWORK', 'offline'));
    expect(await card.findByText('Doğan’s MacBook Pro')).toBeDefined();
    expect(view.getByText(/^Doğan’s MacBook Pro was not signed out\./)).toBeDefined();
    view.unmount();
  });

  test('one already ended elsewhere is what was asked for: it stays gone and nothing is said', async () => {
    const server = held(HERE, MAC);
    const fake = pending(server);
    const { view, card } = await open(fake.api);
    await person().click(await card.findByRole('button', { name: 'Sign out' }));
    // The Mac signed itself out meanwhile: the server has it no longer, and answers as for any unknown id.
    server.sessions = [HERE];
    await fake.answer(new ApiError(404, 'SESSION_NOT_FOUND', 'gone'));
    expect(card.queryByText('Doğan’s MacBook Pro')).toBeNull();
    expect(view.queryByText(/was not signed out/)).toBeNull();
    expect(card.getByText('You are not signed in anywhere else.')).toBeDefined();
    view.unmount();
  });
});
