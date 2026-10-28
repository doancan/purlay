import { describe, expect, test } from 'bun:test';
import { fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import type { SavedSearch, SearchFilters } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { installDom } from '../../testing/dom';
import { aSignedInApi, messageIdAt, WHEN } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { settle } from '../../testing/channel-harness';
import { AdvancedFilters } from './search-filters';

installDom();

describe('advanced search', () => {
  test('filters can be combined, removed and validated without silently accepting a bad repository', async () => {
    let latest: SearchFilters = {};
    const Form = (): React.JSX.Element => {
      const [value, setValue] = useState<SearchFilters>({ status: 'open' });
      return (
        <AdvancedFilters
          value={value}
          onChange={(next) => {
            latest = next;
            setValue(next);
          }}
        />
      );
    };
    const view = await renderApp(<Form />);
    await person().selectOptions(view.getByLabelText('Thread status'), 'resolved');
    await person().selectOptions(view.getByLabelText('Content'), 'code');
    await person().selectOptions(view.getByLabelText('Questions'), 'yes');
    await person().type(view.getByLabelText('From date'), '2026-10-01');
    await person().type(view.getByLabelText('Before date'), '2026-10-29');
    fireEvent.blur(view.getByLabelText('GitHub repository'), {
      target: { value: 'bad repository' },
    });
    expect(view.getByText(/Use an owner\/repository/)).toBeDefined();
    expect(latest.repository).toBeUndefined();
    fireEvent.blur(view.getByLabelText('GitHub repository'), { target: { value: 'acme/api' } });
    expect(latest).toEqual({
      status: 'resolved',
      kind: 'code',
      question: 'yes',
      since: '2026-10-01T00:00:00.000Z',
      until: '2026-10-29T00:00:00.000Z',
      repository: 'acme/api',
    });
    await person().selectOptions(view.getByLabelText('Content'), 'file');
    expect(latest.kind).toBe('file');
    await person().selectOptions(view.getByLabelText('Content'), '');
    await person().selectOptions(view.getByLabelText('Questions'), '');
    await person().selectOptions(view.getByLabelText('Thread status'), 'open');
    await person().clear(view.getByLabelText('From date'));
    await person().clear(view.getByLabelText('Before date'));
    fireEvent.blur(view.getByLabelText('GitHub repository'), { target: { value: '' } });
    await person().selectOptions(view.getByLabelText('Thread status'), '');
    await person().click(view.getByRole('button', { name: 'Clear advanced filters' }));
    expect(latest).toEqual({});
    view.unmount();
  });

  test('a personal search survives a lost response without duplicates, pages, applies and removes', async () => {
    const saved: SavedSearch[] = [];
    const ids: string[] = [];
    let reads = 0;
    let saves = 0;
    let deletes = 0;
    const older: SavedSearch = {
      id: messageIdAt(1),
      name: 'Older',
      query: { q: 'older', status: 'resolved' },
      createdAt: WHEN,
    };
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/search?question=yes',
      api: aSignedInApi({
        search: () => Promise.resolve({ data: [], nextCursor: null }),
        savedSearches: (_workspace, before) => {
          if (++reads === 1) return Promise.reject(new Error('Offline'));
          return Promise.resolve(
            before === undefined
              ? { data: [...saved], nextCursor: saved.length === 0 ? null : (saved[0]?.id ?? null) }
              : { data: [older], nextCursor: null },
          );
        },
        saveSearch: (_workspace, id, input) => {
          ids.push(id);
          if (++saves === 1) return Promise.reject(new Error('Lost response'));
          const result = { ...input, id, createdAt: WHEN };
          saved.push(result);
          return Promise.resolve(result);
        },
        deleteSearch: () => {
          if (++deletes === 1) return Promise.reject(new Error('Offline'));
          saved.length = 0;
          return Promise.resolve();
        },
      }),
    });
    await settle();
    await person().click(view.getByRole('button', { name: 'Saved searches' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText(/No saved searches yet/)).toBeDefined();
    await person().type(view.getByLabelText('Search name'), 'Questions');
    await person().click(view.getByRole('button', { name: 'Save this search' }));
    await settle();
    expect(view.getByRole('alert')).toBeDefined();
    expect(within(view.container).getByLabelText<HTMLInputElement>('Search name').value).toBe(
      'Questions',
    );
    await person().click(view.getByRole('button', { name: 'Save this search' }));
    await settle();
    expect(ids[0]).toBe(ids[1]);
    expect(within(view.container).getByLabelText<HTMLInputElement>('Search name').value).toBe('');
    await person().click(view.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(view.getByRole('button', { name: 'Older' })).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Remove Questions' }));
    await settle();
    expect(view.getByRole('alert')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Remove Questions' }));
    await settle();
    expect(view.queryByRole('button', { name: 'Questions' })).toBeNull();
    // The second page may be pruned on refetch when the first is empty. Save and open it again.
    await person().type(view.getByLabelText('Search name'), 'Questions again');
    await person().click(view.getByRole('button', { name: 'Save this search' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Load more' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Older' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/search?q=older&status=resolved');
    view.unmount();
  });
});
