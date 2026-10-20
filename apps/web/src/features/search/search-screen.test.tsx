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
import {
  ALICE,
  BOB,
  IDS,
  aChannel,
  aMessage,
  aSignedInApi,
  messageIdAt,
  someChannels,
} from '../../testing/fixtures';
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
  test('every message at its own address, which opens its thread for a reply (D-149)', () => {
    expect(placeOf('acme', aMessage(1))).toBe(`/w/acme/c/${IDS.api}?message=${messageIdAt(1)}`);
    expect(placeOf('acme', aMessage(2, { parentId: messageIdAt(1) }))).toBe(
      `/w/acme/c/${IDS.api}?message=${messageIdAt(2)}`,
    );
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
    expect(view.getByRole('button', { name: /the deploy is at noon/ })).toBeDefined();
    await expectNoAxeViolations(view.container);
    await person().click(view.getByRole('button', { name: /the deploy is at noon/ }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}?message=${messageIdAt(4)}`);
    view.unmount();
  });

  test('a found message is shown as it reads, not as it was typed (#651)', async () => {
    const view = await visit({
      search: () =>
        Promise.resolve(
          page([aMessage(4, { sender: BOB, content: 'Deployed `api` `06f1700` to **staging**.' })]),
        ),
    });
    await person().type(field(view), 'deploy');
    await person().keyboard('{Enter}');
    await settle();
    // Read as text: the words are split by the mark of what was searched for (#664).
    expect(view.container.textContent).toContain('Deployed api 06f1700 to staging.');
    expect(view.container.textContent).not.toContain('`');
    view.unmount();
  });

  test('each result marks where the words were found, even past the first lines of a long message (#664)', async () => {
    const long = `${'Context that goes on and on. '.repeat(12)}Then the Deploy window moved to Friday.`;
    const view = await visit({
      search: () =>
        Promise.resolve(
          page([
            aMessage(4, { sender: BOB, content: 'deploy at noon, then deploy again' }),
            aMessage(3, { sender: BOB, content: long }),
          ]),
        ),
    });
    await person().type(field(view), 'deploy');
    await person().keyboard('{Enter}');
    await settle();
    const marks = [...view.container.querySelectorAll('mark')].map((mark) => mark.textContent);
    // Every time the words are said, not only the first.
    expect(marks).toEqual(['deploy', 'deploy', 'Deploy']);
    // Marked in the match tone, full enough to find in a line — not a status pill's faint ground.
    expect(view.container.querySelector('mark')?.className.split(' ')).toContain('bg-match');
    const second = view.container.querySelectorAll('mark')[2]?.parentElement?.textContent ?? '';
    expect(second.startsWith('…')).toBe(true);
    expect(second).toContain('Then the Deploy window moved');
    await expectNoAxeViolations(view.container);
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
    expect(view.getByRole('button', { name: /deploy two/ })).toBeDefined();
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

  test('a person is named by their name, as the feed names them, never by the handle', async () => {
    const direct = aChannel(IDS.dm, null, { type: 'direct_message', peer: BOB });
    const view = await visit({
      channels: () => Promise.resolve([...someChannels(), direct]),
      search: () => Promise.resolve(page([aMessage(4, { sender: BOB, content: 'deploy now' })])),
    });
    await person().type(field(view), 'deploy');
    await person().keyboard('{Enter}');
    await settle();
    const row = view.getByRole('button', { name: /deploy now/ });
    expect(within(row).getByText(BOB.displayName)).toBeDefined();
    expect(within(row).queryByText(BOB.username)).toBeNull();
    expect(within(where(view)).getByRole('option', { name: BOB.displayName })).toBeDefined();
    view.unmount();
  });

  test('a group is offered and said by its people, not as one person (D-127)', async () => {
    const group = aChannel(IDS.dm, null, { type: 'direct_message', peers: [ALICE, BOB] });
    const names = `${ALICE.displayName}, ${BOB.displayName}`;
    const view = await visit(
      {
        channels: () => Promise.resolve([...someChannels(), group]),
        search: () => Promise.resolve(page([])),
      },
      { path: `/w/acme/search?q=deploy&in=${IDS.dm}` },
    );
    expect(within(where(view)).getByRole('option', { name: names })).toBeDefined();
    expect(view.getByText(`Searched ${names}. A deleted message is never found.`)).toBeDefined();
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

describe('narrowed to who wrote it (D-166)', () => {
  const from = (view: Awaited<ReturnType<typeof visit>>, chosen = 'Anyone'): HTMLElement =>
    within(view.container).getByRole('button', { name: `From ${chosen}` });

  const recording = (asked: string[]): Partial<Api> => ({
    search: (_workspace, query): Promise<MessagePage> => {
      asked.push(`${query.q}@${query.channelId ?? 'everywhere'}/${query.senderId ?? 'anyone'}`);
      return Promise.resolve(page([]));
    },
  });

  test('choosing a person asks again for their words alone, keeps them in the address, and says so', async () => {
    const asked: string[] = [];
    const view = await visit(recording(asked), { path: '/w/acme/search?q=deploy' });
    await person().click(from(view));
    const choices = view.getAllByRole('menuitemradio');
    // Anyone, then the person themself, then everybody by name — each with a face.
    // Read without the avatar's letters, which are hidden from a screen reader.
    const words = (choice: HTMLElement): string =>
      choice.textContent.replace(choice.querySelector('[data-avatar]')?.textContent ?? '', '');
    expect(choices.map(words)).toEqual(['Anyone', 'Dogancan you', 'Alice', 'Bob']);
    expect(choices.map((choice) => choice.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(choices[2]?.querySelector('[data-avatar]')).not.toBeNull();
    await expectNoAxeViolations(view.getByRole('menu'));
    await person().click(view.getByRole('menuitemradio', { name: /Alice/ }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/search?q=deploy&from=${IDS.alice}`);
    expect(asked).toEqual(['deploy@everywhere/anyone', `deploy@everywhere/${IDS.alice}`]);
    expect(from(view, 'Alice')).toBeDefined();
    expect(
      view.getByText(
        'Searched what Alice wrote, in every channel you can see. A deleted message is never found.',
      ),
    ).toBeDefined();
    expect(
      view.getByText('Press Enter to search what Alice wrote, in every channel you can see.'),
    ).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('the address keeps both filters: new words keep them, Anyone lets the person go, Back brings them back', async () => {
    const asked: string[] = [];
    const view = await visit(recording(asked), {
      path: `/w/acme/search?q=deploy&in=${IDS.api}&from=${IDS.bob}`,
    });
    expect(from(view, 'Bob')).toBeDefined();
    expect(
      view.getByText('Searched what Bob wrote in #api. A deleted message is never found.'),
    ).toBeDefined();
    await person().clear(field(view));
    await person().type(field(view), 'noon{Enter}');
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(
      `/w/acme/search?q=noon&in=${IDS.api}&from=${IDS.bob}`,
    );
    // Choosing where keeps who.
    await person().selectOptions(
      within(view.container).getByRole<HTMLSelectElement>('combobox', { name: 'Where' }),
      '',
    );
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/search?q=noon&from=${IDS.bob}`);
    await person().click(from(view, 'Bob'));
    await person().click(view.getByRole('menuitemradio', { name: 'Anyone' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/search?q=noon');
    act(() => {
      view.world.history.back();
    });
    await settle();
    expect(from(view, 'Bob')).toBeDefined();
    expect(asked).toEqual([
      `deploy@${IDS.api}/${IDS.bob}`,
      `noon@${IDS.api}/${IDS.bob}`,
      `noon@everywhere/${IDS.bob}`,
      'noon@everywhere/anyone',
    ]);
    view.unmount();
  });

  test('typing a name reaches it, and Enter chooses it', async () => {
    const view = await visit(recording([]), { path: '/w/acme/search?q=deploy' });
    await person().click(from(view));
    await person().keyboard('Bo');
    expect(document.activeElement?.textContent.endsWith('Bob')).toBe(true);
    await person().keyboard('{Enter}');
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/search?q=deploy&from=${IDS.bob}`);
    view.unmount();
  });

  test('somebody no longer listed is still searched for, and said as Someone; not an id is nobody', async () => {
    const asked: string[] = [];
    const gone = '00000000-0000-4000-8000-0000000000ff';
    const view = await visit(recording(asked), { path: `/w/acme/search?q=deploy&from=${gone}` });
    expect(from(view, 'Someone')).toBeDefined();
    view.unmount();
    const odd = await visit(recording(asked), { path: '/w/acme/search?q=deploy&from=alice' });
    expect(from(odd)).toBeDefined();
    expect(asked).toEqual([`deploy@everywhere/${gone}`, 'deploy@everywhere/anyone']);
    odd.unmount();
  });

  test('is said in Turkish when the interface is', async () => {
    const view = await visit(
      { search: () => Promise.resolve(page([])) },
      { path: `/w/acme/search?q=yok&from=${IDS.alice}`, locale: 'tr' },
    );
    expect(within(view.container).getByRole('button', { name: 'Kimden Alice' })).toBeDefined();
    expect(
      view.getByText(
        'Yazan: Alice. Görebildiğin tüm kanallara bakıldı. Silinmiş bir mesaj hiç bulunmaz.',
      ),
    ).toBeDefined();
    await person().click(within(view.container).getByRole('button', { name: 'Kimden Alice' }));
    expect(view.getByRole('menuitemradio', { name: 'Herkes' })).toBeDefined();
    expect(view.getByRole('menuitemradio', { name: /Dogancan sen/ })).toBeDefined();
    view.unmount();
  });
});
