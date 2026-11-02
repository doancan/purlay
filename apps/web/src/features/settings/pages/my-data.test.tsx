/**
 * A person's export of their own data (D-241), on Sessions & account (D-146), against the fake API:
 * everyone's, whatever their role; read first, with its loading, its failure and its empty list; asked
 * for, read again while it is made — on the schedule the test moves — until it is ready; a ready one
 * downloaded once, by a link to the caller's own route; an account gone before it was made said in its
 * own words; one already being made, and the day's limit, refused — in both languages.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { PERSONAL_EXPORTS_PER_DAY, type WorkspaceExport } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const anExport = (overrides: Partial<WorkspaceExport> = {}): WorkspaceExport => ({
  id: '0199155c-6200-7b7f-8c11-0000000000f1',
  status: 'pending',
  createdAt: '2026-10-14T10:00:00.000Z',
  finishedAt: null,
  expiresAt: null,
  sizeBytes: null,
  failure: null,
  ...overrides,
});

const READY = anExport({
  status: 'ready',
  finishedAt: '2026-10-14T10:01:00.000Z',
  expiresAt: '2026-10-15T10:01:00.000Z',
  sizeBytes: 4096,
});

type View = Awaited<ReturnType<typeof renderApp>>;

/** Sessions & account, loaded, as a member: the card is everyone's, not an owner's. */
const open = async (api: Partial<Api>, locale: 'en' | 'tr' = 'en'): Promise<View> => {
  const session = aSession();
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/settings/account',
    locale,
    api: aSignedInApi({
      me: () =>
        Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role: 'member' as const })),
        }),
      ...api,
    }),
  });
  await settle();
  await view.findByRole('heading', {
    level: 1,
    name: locale === 'en' ? 'Sessions & account' : 'Oturumlar ve hesap',
  });
  await settle();
  return view;
};

const cardOf = (view: View, name = 'Your data'): HTMLElement => view.getByRole('region', { name });

const advance = async (view: View, ms: number): Promise<void> => {
  await act(async () => {
    view.world.timers.advance(ms);
    await Promise.resolve();
  });
  await settle();
};

describe('a person’s export of their own data', () => {
  test('asked for by a member, read again while it is made, then offered once as a download', async () => {
    let held: WorkspaceExport[] = [];
    let reads = 0;
    let asked = 0;
    const view = await open({
      myExports: () => {
        reads += 1;
        return Promise.resolve(held);
      },
      requestMyExport: () => {
        asked += 1;
        held = [anExport()];
        return Promise.resolve(anExport());
      },
    });
    const card = cardOf(view);
    expect(within(card).getByText('You have not exported your data yet.')).toBeDefined();
    await expectNoAxeViolations(card);

    await person().click(within(card).getByRole('button', { name: 'Export my data' }));
    await settle();
    expect(asked).toBe(1);
    expect(within(card).getByText('Being made…')).toBeDefined();
    expect(within(card).getByRole('button', { name: 'Export my data' })).toHaveProperty(
      'disabled',
      true,
    );

    const before = reads;
    await advance(view, 3_000);
    expect(reads).toBe(before + 1);
    held = [READY];
    await advance(view, 3_000);
    const link = within(card).getByRole('link', { name: /^Download \(4 kB\) — once, until/ });
    expect(link.getAttribute('href')).toBe(`/api/me/exports/${READY.id}/download`);
    expect(link.hasAttribute('download')).toBe(true);
    await expectNoAxeViolations(card);

    link.addEventListener('click', (event) => {
      event.preventDefault();
    });
    await person().click(link);
    await settle();
    expect(within(card).queryByRole('link')).toBeNull();
    expect(within(card).getByText(/^Downloaded\./)).toBeDefined();
  });

  test('an account gone before it was made is said in its own words; other endings as an owner’s', async () => {
    const view = await open({
      myExports: () =>
        Promise.resolve([
          anExport({
            id: '0199155c-6200-7b7f-8c11-0000000000f2',
            status: 'failed',
            failure: 'EXPORT_REQUESTER_GONE',
          }),
          anExport({ id: '0199155c-6200-7b7f-8c11-0000000000f3', status: 'expired' }),
        ]),
    });
    const list = within(cardOf(view)).getByRole('list', { name: 'Your exports' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.firstElementChild?.textContent),
    ).toEqual([
      'Your account was no longer in use when it was to be made.',
      'Expired before it was downloaded',
    ]);
  });

  test('while it is read, says so; a failure to read offers Retry, which reads again', async () => {
    let calls = 0;
    const view = await open({
      myExports: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(0, 'NETWORK', 'offline');
        return await Promise.resolve([]);
      },
    });
    const card = cardOf(view);
    expect(within(card).getByText('Check your connection and try again.')).toBeDefined();
    expect(within(card).getByRole('button', { name: 'Export my data' })).toHaveProperty(
      'disabled',
      true,
    );
    await person().click(within(card).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(card).getByText('You have not exported your data yet.')).toBeDefined();
    view.unmount();

    const pending = await open({ myExports: () => new Promise(() => undefined) });
    expect(within(cardOf(pending)).getByRole('status')).toBeDefined();
  });

  test('past the day’s limit, says how many a day; one already being made, said so — in Turkish', async () => {
    const view = await open({
      myExports: () => Promise.resolve([]),
      requestMyExport: () => Promise.reject(new ApiError(429, 'RATE_LIMITED', 'slow down')),
    });
    const card = cardOf(view);
    await person().click(within(card).getByRole('button', { name: 'Export my data' }));
    await settle();
    expect(within(card).getByRole('alert').textContent).toBe(
      `You can export your data ${String(PERSONAL_EXPORTS_PER_DAY)} times a day. Try again later.`,
    );
    view.unmount();

    let reads = 0;
    const turkish = await open(
      {
        myExports: () => {
          reads += 1;
          return Promise.resolve(reads === 1 ? [] : [anExport()]);
        },
        requestMyExport: () => Promise.reject(new ApiError(409, 'EXPORT_IN_PROGRESS', 'busy')),
      },
      'tr',
    );
    const kart = cardOf(turkish, 'Verilerin');
    await person().click(within(kart).getByRole('button', { name: 'Verilerimi dışa aktar' }));
    await settle();
    expect(within(kart).getByRole('alert').textContent).toBe(
      'Verilerinin bir dışa aktarımı zaten hazırlanıyor.',
    );
    expect(within(kart).getByText('Hazırlanıyor…')).toBeDefined();
  });
});
