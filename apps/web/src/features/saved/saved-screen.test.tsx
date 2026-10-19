/**
 * The Saved view (#484, D-128) as a person meets it: its three tabs, in the address; each saved
 * message with where and who; moved and let go at once, and said when refused; and its loading,
 * failed and empty states, in both languages.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { SavedItem, SavedPage, SavedState } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, aMessage, aSignedInApi, messageIdAt } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { stateIn } from './saved-screen';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const item = (n: number, state: SavedState = 'in_progress'): SavedItem => ({
  id: `0199155c-${(0x7000 + n).toString(16).padStart(4, '0')}-7b7f-8c11-2a4d3f9e1b70`,
  state,
  savedAt: '2026-09-09T11:00:00.000Z',
  message: aMessage(n, { content: `kept words ${String(n)}` }),
});

const page = (data: readonly SavedItem[], nextCursor: string | null = null): SavedPage => ({
  data: [...data],
  nextCursor,
});

type View = Awaited<ReturnType<typeof renderApp>>;

const visit = async (
  api: Partial<Api>,
  options: { path?: string; locale?: 'tr' } = {},
): Promise<View> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    {
      path: options.path ?? '/w/acme/saved',
      api: aSignedInApi(api),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
    },
  );
  await settle();
  return view;
};

describe('the address', () => {
  test('names the tab; anything else is In progress', () => {
    expect(stateIn('?state=archived')).toBe('archived');
    expect(stateIn('?state=completed')).toBe('completed');
    expect(stateIn('?state=nonsense')).toBe('in_progress');
    expect(stateIn('')).toBe('in_progress');
  });
});

describe('the Saved view', () => {
  test('lists what was saved, newest first, with who and where, from the rail', async () => {
    const asked: string[] = [];
    const view = await visit({
      saved: (_workspace, state) => {
        asked.push(state);
        return Promise.resolve(page([item(2), item(1)]));
      },
    });
    expect(view.getByRole('heading', { level: 1, name: 'Saved' })).toBeDefined();
    expect(asked).toEqual(['in_progress']);
    const rows = within(view.getByRole('main'))
      .getAllByRole('listitem')
      .map((row) => row.textContent);
    expect(rows[0]).toContain('kept words 2');
    expect(rows[0]).toContain('#api');
    expect(rows[1]).toContain('kept words 1');
    expect(view.getByRole('link', { name: 'Saved' }).getAttribute('aria-current')).toBe('page');
    expect(view.getByRole('button', { name: 'In progress' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a tab is asked for, and kept in the address', async () => {
    const asked: string[] = [];
    const view = await visit({
      saved: (_workspace, state) => {
        asked.push(state);
        return Promise.resolve(page([]));
      },
    });
    await person().click(view.getByRole('button', { name: 'Archived' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/saved?state=archived');
    expect(asked).toEqual(['in_progress', 'archived']);
    expect(view.getByText('Nothing archived')).toBeDefined();
    view.unmount();
  });

  test('a saved message opens its conversation at the message', async () => {
    const view = await visit({ saved: () => Promise.resolve(page([item(1)])) });
    await person().click(view.getByRole('button', { name: /kept words 1/ }));
    // At the message itself, not the channel's bottom (D-149).
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}?message=${messageIdAt(1)}`);
    view.unmount();
  });

  test('moved to Completed, it leaves this tab at once and the server is asked', async () => {
    const moved: [string, SavedState | undefined][] = [];
    const view = await visit({
      saved: () => Promise.resolve(page([item(1)])),
      saveMessage: (messageId, state) => {
        moved.push([messageId, state]);
        return new Promise(() => undefined);
      },
    });
    await person().click(view.getByRole('button', { name: 'Complete' }));
    expect(view.queryByText('kept words 1')).toBeNull();
    expect(moved).toEqual([[messageIdAt(1), 'completed']]);
    view.unmount();
  });

  test('moved and kept by the server, every view of the saves is read again', async () => {
    let reads = 0;
    const view = await visit({
      saved: () => {
        reads += 1;
        return Promise.resolve(page(reads === 1 ? [item(1)] : []));
      },
      saveMessage: () => Promise.resolve(),
    });
    await person().click(view.getByRole('button', { name: 'Archive' }));
    await settle();
    expect(reads).toBe(2);
    expect(view.getByText('Nothing saved to come back to')).toBeDefined();
    view.unmount();
  });

  test('let go but refused: the list is read again, and the toast says why', async () => {
    let reads = 0;
    const view = await visit({
      saved: () => {
        reads += 1;
        return Promise.resolve(page([item(1)]));
      },
      unsaveMessage: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    await person().click(view.getByRole('button', { name: 'Remove from saved' }));
    await settle();
    expect(view.getByText(/^The message was not removed from saved\./)).toBeDefined();
    expect(reads).toBe(2);
    expect(view.getByText('kept words 1')).toBeDefined();
    view.unmount();
  });

  test('more is a page away', async () => {
    const view = await visit({
      saved: (_workspace, _state, before) =>
        Promise.resolve(before === undefined ? page([item(2)], item(2).id) : page([item(1)])),
    });
    await person().click(view.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(view.getByText('kept words 1')).toBeDefined();
    expect(view.queryByRole('button', { name: 'Load more' })).toBeNull();
    view.unmount();
  });

  test('says when it is loading, when it failed — with Retry — and when there is nothing', async () => {
    const loading = await visit({ saved: () => new Promise(() => undefined) });
    expect(loading.getByText('Loading your saved messages')).toBeDefined();
    loading.unmount();

    let fail = true;
    const failed = await visit({
      saved: () =>
        fail ? Promise.reject(new ApiError(500, 'INTERNAL', 'no')) : Promise.resolve(page([])),
    });
    expect(failed.getByText('Your saved messages could not be loaded')).toBeDefined();
    fail = false;
    await person().click(failed.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(failed.getByText('Nothing saved to come back to')).toBeDefined();
    failed.unmount();
  });

  test('is said in Turkish when the interface is', async () => {
    const view = await visit(
      { saved: () => Promise.resolve(page([], null)) },
      { locale: 'tr', path: '/w/acme/saved?state=completed' },
    );
    expect(view.getByRole('heading', { level: 1, name: 'Kaydedilenler' })).toBeDefined();
    expect(view.getByText('Henüz tamamlanan bir şey yok')).toBeDefined();
    view.unmount();
  });
});
