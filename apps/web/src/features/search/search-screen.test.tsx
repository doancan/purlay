/**
 * Search (D-105, `UX.md` §8): what is asked and when, what a found message says and where it goes,
 * the words kept in the address, and the states — progress in the field, nothing found, failed.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { SEARCH_QUERY_MIN, type Message, type MessagePage } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { BOB, IDS, aMessage, aSignedInApi, messageIdAt } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { placeOf } from './search-screen';

installDom();

const page = (data: readonly Message[], nextCursor: string | null = null): MessagePage => ({
  data: [...data],
  nextCursor,
});

const visit = async (
  api: Partial<Api>,
  options: { readonly path?: string; readonly locale?: 'tr' } = {},
): ReturnType<typeof renderApp> => {
  const view = await renderApp(<Outlet />, {
    path: options.path ?? '/w/acme/search',
    api: aSignedInApi(api),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  });
  await settle();
  return view;
};

const field = (view: Awaited<ReturnType<typeof visit>>): HTMLInputElement =>
  within(view.container).getByLabelText<HTMLInputElement>('Search messages');

describe('where a found message is read', () => {
  test('a reply in its thread, a question with answers in its thread, anything else in its channel', () => {
    expect(placeOf('acme', aMessage(1))).toBe(`/w/acme/c/${IDS.api}`);
    expect(placeOf('acme', aMessage(2, { parentId: messageIdAt(1) }))).toBe(
      `/w/acme/c/${IDS.api}?thread=${messageIdAt(1)}`,
    );
    const answered = aMessage(3, {
      thread: { replyCount: 2, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
    });
    expect(placeOf('acme', answered)).toBe(`/w/acme/c/${IDS.api}?thread=${messageIdAt(3)}`);
  });
});

describe('asking', () => {
  test('nothing is asked until Enter, and the words go into the address, trimmed', async () => {
    const asked: string[] = [];
    const view = await visit({
      search: (_workspace, query) => {
        asked.push(query.q);
        return Promise.resolve(
          page([aMessage(4, { sender: BOB, content: 'the deploy is at noon' })]),
        );
      },
    });
    await person().type(field(view), '  deploy ');
    expect(asked).toEqual([]);
    await person().keyboard('{Enter}');
    await settle();
    expect(asked).toEqual(['deploy']);
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/search?q=deploy');
    expect(view.getByText('the deploy is at noon')).toBeDefined();
    await expectNoAxeViolations(view.container);
    await person().click(view.getByRole('button', { name: /the deploy is at noon/ }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}`);
    view.unmount();
  });

  test('below the minimum it says so in the field and asks nothing; at the minimum it asks', async () => {
    const asked: string[] = [];
    const view = await visit({
      search: (_workspace, query) => {
        asked.push(query.q);
        return Promise.resolve(page([]));
      },
    });
    await person().type(field(view), `${'a'.repeat(SEARCH_QUERY_MIN - 1)}{Enter}`);
    expect(view.getByText(`Type at least ${String(SEARCH_QUERY_MIN)} characters.`)).toBeDefined();
    expect(field(view).getAttribute('aria-invalid')).toBe('true');
    expect(asked).toEqual([]);
    await person().type(field(view), 'a{Enter}');
    await settle();
    expect(asked).toEqual(['a'.repeat(SEARCH_QUERY_MIN)]);
    view.unmount();
  });

  test('an address with words searches at once, the words in the field; Back brings the old words back', async () => {
    const view = await visit(
      { search: (_workspace, query) => Promise.resolve(page([aMessage(4, { content: query.q })])) },
      { path: '/w/acme/search?q=first' },
    );
    expect(field(view).value).toBe('first');
    expect(view.getByText('first')).toBeDefined();
    await person().clear(field(view));
    await person().type(field(view), 'second{Enter}');
    await settle();
    expect(view.getByText('second')).toBeDefined();
    act(() => {
      view.world.history.back();
    });
    await settle();
    expect(field(view).value).toBe('first');
    view.unmount();
  });

  test('an address with too few characters asks nothing, and says what search does', async () => {
    // `search` is not given: the fake fails the test if it is called.
    const view = await visit({}, { path: `/w/acme/search?q=${'a'.repeat(SEARCH_QUERY_MIN - 1)}` });
    expect(view.getByText(/The words as typed, ignoring case/)).toBeDefined();
    view.unmount();
  });

  test('more is a page away', async () => {
    const asked: (string | undefined)[] = [];
    const view = await visit(
      {
        search: (_workspace, query) => {
          asked.push(query.before);
          return Promise.resolve(
            query.before === undefined
              ? page([aMessage(4, { content: 'deploy four' })], messageIdAt(4))
              : page([aMessage(2, { content: 'deploy two' })]),
          );
        },
      },
      { path: '/w/acme/search?q=deploy' },
    );
    await person().click(view.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(asked).toEqual([undefined, messageIdAt(4)]);
    expect(view.getByText('deploy two')).toBeDefined();
    view.unmount();
  });
});

describe('the states', () => {
  test('searching is said in the field; nothing found says what and where it looked', async () => {
    let answer: (value: MessagePage) => void = () => undefined;
    const view = await visit(
      {
        search: () =>
          new Promise<MessagePage>((resolve) => {
            answer = resolve;
          }),
      },
      { path: '/w/acme/search?q=nothing' },
    );
    expect(field(view).getAttribute('aria-busy')).toBe('true');
    expect(view.getByText('Searching…')).toBeDefined();
    answer(page([]));
    await settle();
    expect(field(view).getAttribute('aria-busy')).toBe('false');
    expect(view.getByRole('heading', { name: 'No matches for “nothing”' })).toBeDefined();
    expect(view.getByText(/Searched every channel you can see/)).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('failed says so with a Retry, and the words stay in the field', async () => {
    let attempts = 0;
    const view = await visit(
      {
        search: () => {
          attempts += 1;
          return attempts === 1
            ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
            : Promise.resolve(page([aMessage(4, { content: 'found it' })]));
        },
      },
      { path: '/w/acme/search?q=deploy' },
    );
    expect(view.getByRole('alert').textContent).toContain("Couldn't search");
    expect(field(view).value).toBe('deploy');
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('found it')).toBeDefined();
    view.unmount();
  });

  test('is said in Turkish when the interface is', async () => {
    const view = await visit(
      { search: () => Promise.resolve(page([])) },
      { path: '/w/acme/search?q=yok', locale: 'tr' },
    );
    expect(view.getByRole('heading', { level: 1, name: 'Ara' })).toBeDefined();
    expect(view.getByRole('heading', { name: '“yok” için sonuç yok' })).toBeDefined();
    view.unmount();
  });

  test('the sidebar has Search, current on the search screen', async () => {
    const view = await visit({});
    expect(view.getByRole('link', { name: 'Search' }).getAttribute('aria-current')).toBe('page');
    view.unmount();
  });
});

describe('narrowed to a channel (`PRD.md` §4.6)', () => {
  const where = (view: Awaited<ReturnType<typeof visit>>): HTMLSelectElement =>
    within(view.container).getByRole<HTMLSelectElement>('combobox', { name: 'Where' });

  test('choosing a channel asks again in it alone, keeps the choice in the address, and says where it looked', async () => {
    const asked: string[] = [];
    const view = await visit(
      {
        search: (_workspace, query) => {
          asked.push(`${query.q}@${query.channelId ?? 'everywhere'}`);
          return Promise.resolve(page([]));
        },
      },
      { path: '/w/acme/search?q=deploy' },
    );
    expect(where(view).value).toBe('');
    await person().selectOptions(where(view), IDS.deploys);
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/search?q=deploy&in=${IDS.deploys}`);
    expect(asked).toEqual(['deploy@everywhere', `deploy@${IDS.deploys}`]);
    expect(view.getByText('Searched #deploys. A deleted message is never found.')).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('an address that names a channel opens narrowed, new words keep it, and Every channel lets it go', async () => {
    const asked: string[] = [];
    const view = await visit(
      {
        search: (_workspace, query) => {
          asked.push(`${query.q}@${query.channelId ?? 'everywhere'}`);
          return Promise.resolve(page([]));
        },
      },
      { path: `/w/acme/search?q=deploy&in=${IDS.api}` },
    );
    expect(where(view).value).toBe(IDS.api);
    await person().clear(field(view));
    await person().type(field(view), 'noon{Enter}');
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/search?q=noon&in=${IDS.api}`);
    await person().selectOptions(where(view), '');
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/search?q=noon');
    expect(asked).toEqual([`deploy@${IDS.api}`, `noon@${IDS.api}`, 'noon@everywhere']);
    view.unmount();
  });

  test('an address that names something that is not a channel id searches everywhere, and sends nothing odd', async () => {
    const asked: (string | undefined)[] = [];
    const view = await visit(
      {
        search: (_workspace, query) => {
          asked.push(query.channelId);
          return Promise.resolve(page([]));
        },
      },
      { path: '/w/acme/search?q=deploy&in=not-a-channel' },
    );
    expect(asked).toEqual([undefined]);
    expect(where(view).value).toBe('');
    view.unmount();
  });
});
