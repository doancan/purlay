/**
 * An owner's export of the workspace (D-140), against the fake API: an owner's alone; read first, with
 * its loading, its failure and its empty list; asked for, then read again while it is made — on the
 * schedule the test moves — until it is ready; a ready one downloaded once, by a link to the API; a
 * failed one said by its code; one already being made refused, in both languages.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { UserRole, WorkspaceExport } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { en } from '../../i18n/catalogue/en';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, WORKSPACE, aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';

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

const open = async (
  api: Partial<Api>,
  role: UserRole = 'owner',
  locale: 'en' | 'tr' = 'en',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const session = aSession();
  const view = await renderApp(<Outlet />, {
    path: `/w/acme/c/${IDS.api}`,
    locale,
    api: aSignedInApi({
      me: () =>
        Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role })),
        }),
      ...api,
    }),
  });
  await settle();
  const switcher = locale === 'en' ? 'Switch workspace' : 'Çalışma alanını değiştir';
  await person().click(view.getByRole('button', { name: switcher }));
  return view;
};

const dialogOf = async (
  view: Awaited<ReturnType<typeof renderApp>>,
  entry = 'Export workspace…',
): Promise<HTMLElement> => {
  await person().click(view.getByRole('menuitem', { name: entry }));
  await settle();
  return view.getByRole('dialog');
};

describe('an owner’s export of the workspace', () => {
  test('is an owner’s alone: an admin and a member are not offered it', async () => {
    for (const role of ['admin', 'member'] as const) {
      const view = await open({}, role);
      expect(view.queryByRole('menuitem', { name: 'Export workspace…' })).toBeNull();
      view.unmount();
    }
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
    const dialog = await dialogOf(view);
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
      const dialog = await dialogOf(view);
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

  test('closed while one is being made, the list is not read again', async () => {
    let reads = 0;
    const view = await open({
      exports: () => {
        reads += 1;
        return Promise.resolve([anExport()]);
      },
    });
    const dialog = await dialogOf(view);
    await person().click(within(dialog).getByRole('button', { name: 'Close' }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
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
    const dialog = await dialogOf(view);
    const list = within(dialog).getByRole('list', { name: 'Your exports' });
    const said = within(list)
      .getAllByRole('listitem')
      .map((item) => item.lastElementChild?.textContent);
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
    const dialog = await dialogOf(view);
    expect(within(dialog).getByText('Check your connection and try again.')).toBeDefined();
    expect(within(dialog).getByRole('button', { name: 'Export' })).toHaveProperty('disabled', true);
    await person().click(within(dialog).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(dialog).getByText('You have not exported this workspace yet.')).toBeDefined();
    view.unmount();

    const pending = await open({ exports: () => new Promise(() => undefined) });
    const waiting = await dialogOf(pending);
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
    const dialog = await dialogOf(view, 'Çalışma alanını dışa aktar…');
    await person().click(within(dialog).getByRole('button', { name: 'Dışa aktar' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Bu çalışma alanının bir dışa aktarımı zaten hazırlanıyor.',
    );
    expect(within(dialog).getByText('Hazırlanıyor…')).toBeDefined();
  });

  test('any other refusal is said with its reason, and gone when the dialog opens again', async () => {
    const view = await open({
      exports: () => Promise.resolve([]),
      requestExport: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')),
    });
    let dialog = await dialogOf(view);
    await person().click(within(dialog).getByRole('button', { name: 'Export' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toBe(
      `The export was not asked for. ${en['failure.gone']}`,
    );
    await person().click(within(dialog).getByRole('button', { name: 'Close' }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    dialog = await dialogOf(view);
    expect(within(dialog).queryByRole('alert')).toBeNull();
  });
});
