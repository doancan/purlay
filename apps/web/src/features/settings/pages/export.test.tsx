/**
 * An owner's export of the workspace (D-140), on the Data & retention page (D-146), against the fake API: an owner's alone; read first, with
 * its loading, its failure and its empty list; asked for, then read again while it is made — on the
 * schedule the test moves — until it is ready; a ready one downloaded once, by a link to the API; a
 * failed one said by its code; one already being made refused, in both languages.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { UserRole, WorkspaceExport } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { en } from '../../../i18n/catalogue/en';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { WORKSPACE, aSession, aSignedInApi } from '../../../testing/fixtures';
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
  id: '0199155c-6200-7b7f-8c11-0000000000e1',
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
  sizeBytes: 2048,
});

type View = Awaited<ReturnType<typeof renderApp>>;

const render = async (
  path: string,
  api: Partial<Api>,
  role: UserRole,
  locale: 'en' | 'tr',
): Promise<View> => {
  const session = aSession();
  const view = await renderApp(<Outlet />, {
    path,
    locale,
    api: aSignedInApi({
      me: () =>
        Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role })),
        }),
      // The page's other card: how long history is kept.
      retention: () => Promise.resolve({ retentionDays: null, channelsKeptLonger: 0 }),
      ...api,
    }),
  });
  await settle();
  return view;
};

/** The Data & retention page, loaded: its chunk is lazy, so the heading is waited for. */
const open = async (
  api: Partial<Api>,
  role: UserRole = 'owner',
  locale: 'en' | 'tr' = 'en',
): Promise<View> => {
  const view = await render('/w/acme/settings/data', api, role, locale);
  await view.findByRole('heading', {
    level: 1,
    name: locale === 'en' ? 'Data & retention' : 'Veri ve saklama',
  });
  await settle();
  return view;
};

/** The export's card on the page. */
const cardOf = (view: View, name = 'Export'): HTMLElement => view.getByRole('region', { name });

/** Leaves for Profile and comes back, as a person moving between the pages would. */
const leaveAndReturn = async (view: View): Promise<void> => {
  await person().click(view.getByRole('link', { name: 'Profile' }));
  await view.findByRole('heading', { level: 1, name: 'Profile' });
  await person().click(view.getByRole('link', { name: 'Data & retention' }));
  await view.findByRole('heading', { level: 1, name: 'Data & retention' });
  await settle();
};

describe('an owner’s export of the workspace', () => {
  test('is an owner’s alone: an admin and a member are not offered it, and its address is not found', async () => {
    for (const role of ['admin', 'member'] as const) {
      const view = await render('/w/acme/settings/data', {}, role, 'en');
      expect(await view.findByText('Nothing here')).toBeDefined();
      expect(view.queryByRole('link', { name: 'Data & retention' })).toBeNull();
      view.unmount();
    }
    const owner = await open({ exports: () => Promise.resolve([]) });
    expect(owner.getByRole('link', { name: 'Data & retention' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  test('asked for, read again while it is made, then offered once as a download', async () => {
    let held: WorkspaceExport[] = [];
    let reads = 0;
    const asked: string[] = [];
    const view = await open({
      exports: () => {
        reads += 1;
        return Promise.resolve(held);
      },
      requestExport: (workspaceId) => {
        asked.push(workspaceId);
        held = [anExport()];
        return Promise.resolve(anExport());
      },
    });
    const dialog = cardOf(view);
    expect(within(dialog).getByText('You have not exported this workspace yet.')).toBeDefined();
    await expectNoAxeViolations(dialog);

    await person().click(within(dialog).getByRole('button', { name: 'Export' }));
    await settle();
    expect(asked).toEqual([WORKSPACE.id]);
    expect(within(dialog).getByText('Being made…')).toBeDefined();
    // One at a time: nothing more to ask for while it is made.
    expect(within(dialog).getByRole('button', { name: 'Export' })).toHaveProperty('disabled', true);

    // Still being made at the next read; ready at the one after.
    const before = reads;
    await act(async () => {
      view.world.timers.advance(3_000);
      await Promise.resolve();
    });
    await settle();
    expect(reads).toBe(before + 1);
    held = [READY];
    await act(async () => {
      view.world.timers.advance(3_000);
      await Promise.resolve();
    });
    await settle();
    const link = within(dialog).getByRole('link', { name: /^Download \(2 kB\) — once, until/ });
    expect(link.getAttribute('href')).toBe(
      `/api/workspaces/${WORKSPACE.id}/exports/${READY.id}/download`,
    );
    expect(link.hasAttribute('download')).toBe(true);
    // Ready: nothing is read again.
    const settled = reads;
    await act(async () => {
      view.world.timers.advance(30_000);
      await Promise.resolve();
    });
    await settle();
    expect(reads).toBe(settled);
    expect(within(dialog).getByRole('button', { name: 'Export' })).toHaveProperty(
      'disabled',
      false,
    );
    await expectNoAxeViolations(dialog);

    // Followed once, it is spent here as on the server: no second link.
    link.addEventListener('click', (event) => {
      event.preventDefault();
    });
    await person().click(link);
    await settle();
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(within(dialog).getByText(/^Downloaded\./)).toBeDefined();
    // Then read from the server, which spent it too.
    held = [{ ...READY, status: 'downloaded' }];
    const followed = reads;
    await act(async () => {
      view.world.timers.advance(3_000);
      await Promise.resolve();
    });
    await settle();
    expect(reads).toBe(followed + 1);
    expect(within(dialog).getByText(/^Downloaded\./)).toBeDefined();
  });

  for (const [what, server, shown] of [
    ['never reached the server: the link is offered again', READY, 'link'],
    ['came after it expired: it says so', { ...READY, status: 'expired' as const }, 'expired'],
  ] as const) {
    test(`a download that ${what}`, async () => {
      let held: WorkspaceExport[] = [READY];
      const view = await open({ exports: () => Promise.resolve(held) });
      const dialog = cardOf(view);
      const link = within(dialog).getByRole('link');
      link.addEventListener('click', (event) => {
        event.preventDefault();
      });
      // A middle click opens it as surely as a click.
      if (shown === 'link') await person().click(link);
      else
        await act(async () => {
          link.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 }));
          await Promise.resolve();
        });
      await settle();
      expect(within(dialog).queryByRole('link')).toBeNull();
      // What the server holds, read shortly after, replaces the guess.
      held = [server];
      await act(async () => {
        view.world.timers.advance(3_000);
        await Promise.resolve();
      });
      await settle();
      if (shown === 'link') expect(within(dialog).getByRole('link')).toBeDefined();
      else expect(within(dialog).getByText('Expired before it was downloaded')).toBeDefined();
    });
  }

  test('left while one is being made, the list is not read again', async () => {
    let reads = 0;
    const view = await open({
      exports: () => {
        reads += 1;
        return Promise.resolve([anExport()]);
      },
    });
    expect(within(cardOf(view)).getByText('Being made…')).toBeDefined();
    await person().click(view.getByRole('link', { name: 'Profile' }));
    await view.findByRole('heading', { level: 1, name: 'Profile' });
    await settle();
    const closed = reads;
    await act(async () => {
      view.world.timers.advance(30_000);
      await Promise.resolve();
    });
    await settle();
    expect(reads).toBe(closed);
  });

  test('each way an export ends is said: expired, and failed by its code', async () => {
    const view = await open({
      exports: () =>
        Promise.resolve([
          anExport({ id: '0199155c-6200-7b7f-8c11-0000000000e2', status: 'expired' }),
          anExport({
            id: '0199155c-6200-7b7f-8c11-0000000000e3',
            status: 'failed',
            failure: 'EXPORT_ABANDONED',
          }),
          anExport({
            id: '0199155c-6200-7b7f-8c11-0000000000e4',
            status: 'failed',
            failure: 'EXPORT_REQUESTER_GONE',
          }),
          anExport({
            id: '0199155c-6200-7b7f-8c11-0000000000e5',
            status: 'failed',
            failure: 'EXPORT_FAILED',
          }),
          anExport({
            id: '0199155c-6200-7b7f-8c11-0000000000e6',
            status: 'failed',
            failure: 'STORAGE_UNAVAILABLE',
          }),
        ]),
    });
    const dialog = cardOf(view);
    const list = within(dialog).getByRole('list', { name: 'Your exports' });
    const said = within(list)
      .getAllByRole('listitem')
      .map((item) => item.firstElementChild?.textContent);
    expect(said).toEqual([
      'Expired before it was downloaded',
      'It was cut off when the server restarted. Try again.',
      'You were no longer an owner when it was to be made.',
      'It could not be made. Try again.',
      'Something went wrong on our side. Try again in a moment.',
    ]);
    expect(within(list).getAllByText(/^Asked for /)).toHaveLength(5);
  });

  test('while it is read, says so; a failure to read offers Retry, which reads again', async () => {
    let calls = 0;
    const view = await open({
      exports: async () => {
        calls += 1;
        if (calls === 1) throw new ApiError(0, 'NETWORK', 'offline');
        return await Promise.resolve([]);
      },
    });
    const dialog = cardOf(view);
    expect(within(dialog).getByText('Check your connection and try again.')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Export' })).toHaveProperty('disabled', true);
    await person().click(within(dialog).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(dialog).getByText('You have not exported this workspace yet.')).toBeDefined();
    view.unmount();

    const pending = await open({ exports: () => new Promise(() => undefined) });
    const waiting = cardOf(pending);
    expect(within(waiting).getByRole('status')).toBeDefined();
  });

  test('one already being made is said so, and the list read again — in Turkish too', async () => {
    let reads = 0;
    const view = await open(
      {
        exports: () => {
          reads += 1;
          return Promise.resolve(reads === 1 ? [] : [anExport()]);
        },
        requestExport: () => Promise.reject(new ApiError(409, 'EXPORT_IN_PROGRESS', 'busy')),
      },
      'owner',
      'tr',
    );
    const dialog = cardOf(view, 'Dışa aktarma');
    await person().click(within(dialog).getByRole('button', { name: 'Dışa aktar' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Bu çalışma alanının bir dışa aktarımı zaten hazırlanıyor.',
    );
    expect(within(dialog).getByText('Hazırlanıyor…')).toBeDefined();
  });

  test('any other refusal is said with its reason, and gone when the page is opened again', async () => {
    const view = await open({
      exports: () => Promise.resolve([]),
      requestExport: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')),
    });
    let dialog = cardOf(view);
    await person().click(within(dialog).getByRole('button', { name: 'Export' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toBe(
      `The export was not asked for. ${en['failure.gone']}`,
    );
    await leaveAndReturn(view);
    dialog = cardOf(view);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
});
