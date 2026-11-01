/**
 * Search (D-105, `UX.md` §8): what is asked and when, what a found message says and where it goes,
 * the words kept in the address, and the states — progress in the field, nothing found, failed.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import {
  SEARCH_QUERY_MAX,
  SEARCH_QUERY_MIN,
  type Message,
  type MessagePage,
  type SavedSearch,
} from '@purlay/types';
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
  WHEN,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { placeOf } from './search-screen';
import { dayShown } from '../../testing/date';

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

/** What the screen asked the server, as the client's `search` takes it. */
type Asked = Parameters<Api['search']>[1];

describe('operators typed with the words (D-224)', () => {
  const where = (view: Awaited<ReturnType<typeof visit>>): HTMLSelectElement =>
    within(view.container).getByRole<HTMLSelectElement>('combobox', { name: 'Where' });
  const notice = (view: Awaited<ReturnType<typeof visit>>): HTMLElement => {
    const said = view
      .getAllByRole('status')
      .find((node) => node.textContent.includes('was searched for as words'));
    if (said === undefined) throw new Error('Nothing is said about the operators');
    return said;
  };
  const recording = (asked: Asked[]): Partial<Api> => ({
    search: (_workspace, query): Promise<MessagePage> => {
      asked.push(query);
      return Promise.resolve(page([]));
    },
  });

  test('Enter reads them into the filters the controls show, and the address keeps the rest of the words', async () => {
    const asked: Asked[] = [];
    const view = await visit(recording(asked));
    await person().type(field(view), 'in:#api FROM:@alice has:code deploy "is:open"{Enter}');
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(
      `/w/acme/search?q=deploy+is%3Aopen&in=${IDS.api}&from=${IDS.alice}&kind=code`,
    );
    expect(
      asked.map(({ q, channelId, senderId, kind }) => ({ q, channelId, senderId, kind })),
    ).toEqual([{ q: 'deploy is:open', channelId: IDS.api, senderId: IDS.alice, kind: 'code' }]);
    // The field keeps what was searched for as words, quoted where it would read as a filter.
    expect(field(view).value).toBe('deploy "is:open"');
    expect(where(view).value).toBe(IDS.api);
    expect(within(view.container).getByRole('button', { name: 'From Alice' })).toBeDefined();
    expect(within(view.container).getByLabelText<HTMLSelectElement>('Content').value).toBe('code');
    await person().type(field(view), '{Enter}');
    await settle();
    // Asked again, it is the same search: the quoted words did not become a filter.
    expect(asked.at(-1)?.q).toBe('deploy is:open');
    expect(asked.at(-1)?.status).toBeUndefined();
    view.unmount();
  });

  test('a name nobody has is searched for as words and said under the field, as is a value no filter takes', async () => {
    const asked: Asked[] = [];
    const view = await visit(recording(asked));
    await person().type(field(view), 'in:#nowhere from:@nobody is:closed deploy{Enter}');
    await settle();
    expect(asked.map((query) => query.q)).toEqual(['in:#nowhere from:@nobody is:closed deploy']);
    const said = notice(view);
    expect(said.textContent).toContain(
      'No channel you can see is called “#nowhere”, so “in:#nowhere” was searched for as words.',
    );
    expect(said.textContent).toContain(
      'Nobody here has the username “@nobody”, so “from:@nobody” was searched for as words.',
    );
    expect(said.textContent).toContain(
      '“is:closed” is not a filter search understands, so it was searched for as words.',
    );
    // Left bare in the field, to be corrected: corrected, it is read.
    expect(field(view).value).toBe('in:#nowhere from:@nobody is:closed deploy');
    await expectNoAxeViolations(view.container);
    await person().clear(field(view));
    await person().type(field(view), 'in:#deploys deploy{Enter}');
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/search?q=deploy&in=${IDS.deploys}`);
    expect(view.queryByText(/was searched for as words/)).toBeNull();
    view.unmount();
  });

  test('said again from the address alone, after a reload', async () => {
    const view = await visit(recording([]), {
      path: `/w/acme/search?q=${encodeURIComponent('in:#nowhere deploy')}`,
    });
    expect(notice(view).textContent).toContain('“in:#nowhere” was searched for as words');
    view.unmount();
  });

  test('changing a control keeps the words typed, reads their operators, and what was typed wins', async () => {
    const view = await visit(recording([]), { path: '/w/acme/search?q=deploy' });
    await person().clear(field(view));
    await person().type(field(view), 'noon is:open');
    await person().selectOptions(where(view), IDS.deploys);
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(
      `/w/acme/search?q=noon&in=${IDS.deploys}&status=open`,
    );
    expect(field(view).value).toBe('noon');
    await person().clear(field(view));
    await person().type(field(view), 'noon in:#api');
    await person().selectOptions(within(view.container).getByLabelText('Questions'), 'yes');
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(
      `/w/acme/search?q=noon&in=${IDS.api}&status=open&question=yes`,
    );
    await person().clear(field(view));
    await person().type(field(view), 'noon in:#incidents');
    await person().selectOptions(where(view), IDS.deploys);
    await settle();
    expect(where(view).value).toBe(IDS.incidents);
    view.unmount();
  });

  test('Back returns to the search before the operators were read', async () => {
    const view = await visit(recording([]), { path: '/w/acme/search?q=deploy' });
    await person().type(field(view), ' has:file{Enter}');
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/search?q=deploy&kind=file');
    act(() => {
      view.world.history.back();
    });
    await settle();
    expect(field(view).value).toBe('deploy');
    expect(within(view.container).getByLabelText<HTMLSelectElement>('Content').value).toBe('');
    view.unmount();
  });

  test('a day is the viewer’s whole day, and the date fields show it', async () => {
    const asked: Asked[] = [];
    const view = await visit(recording(asked));
    await person().type(field(view), 'on:2026-10-31{Enter}');
    await settle();
    expect(asked.map(({ q, since, until }) => ({ q, since, until }))).toEqual([
      { q: '', since: '2026-10-31T00:00:00.000Z', until: '2026-11-01T00:00:00.000Z' },
    ]);
    expect(dayShown(within(view.container), 'From date')).toContain('October 31, 2026');
    expect(dayShown(within(view.container), 'Before date')).toContain('November 1, 2026');
    view.unmount();
  });

  test('a range that ends before it starts, too many words, or too few beside a filter is said in the field and not asked', async () => {
    const view = await visit({});
    await person().type(field(view), 'deploy after:2026-10-05 before:2026-10-01{Enter}');
    expect(view.getByText('The end date must come after the start date.')).toBeDefined();
    expect(field(view).getAttribute('aria-invalid')).toBe('true');
    await person().clear(field(view));
    await person().click(field(view));
    await person().paste(`${'a'.repeat(SEARCH_QUERY_MAX)} has:code b`);
    await person().keyboard('{Enter}');
    expect(view.getByText(`Use at most ${String(SEARCH_QUERY_MAX)} characters.`)).toBeDefined();
    await person().clear(field(view));
    await person().type(field(view), 'in:#api ab{Enter}');
    expect(view.getByText(`Type at least ${String(SEARCH_QUERY_MIN)} characters.`)).toBeDefined();
    expect(view.world.history.stack).toEqual(['/w/acme/search']);
    view.unmount();
  });

  test('what can be typed is a disclosure under the field, in both languages', async () => {
    const view = await visit({});
    const help = view.getByText('Search operators');
    expect(help.closest('details')?.open).toBe(false);
    await person().click(help);
    expect(help.closest('details')?.open).toBe(true);
    expect(view.getByText('in:#channel')).toBeDefined();
    expect(view.getByText('"exact words"')).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
    const turkish = await visit({}, { locale: 'tr' });
    expect(turkish.getByText('Arama işleçleri')).toBeDefined();
    turkish.unmount();
  });

  test('a saved search keeps the filters the operators set, not the line typed, and comes back to them', async () => {
    const saved: SavedSearch[] = [];
    const view = await visit({
      ...recording([]),
      savedSearches: () => Promise.resolve({ data: [...saved], nextCursor: null }),
      saveSearch: (_workspace, id, input) => {
        const result = { ...input, id, createdAt: WHEN };
        saved.push(result);
        return Promise.resolve(result);
      },
    });
    await person().type(field(view), 'in:#api is:resolved rollback{Enter}');
    await settle();
    const searched = view.world.history.stack.at(-1);
    await person().click(view.getByRole('button', { name: 'Saved searches' }));
    await settle();
    await person().type(view.getByLabelText('Search name'), 'Rollbacks');
    await person().click(view.getByRole('button', { name: 'Save this search' }));
    await settle();
    expect(saved.map((each) => each.query)).toEqual([
      { q: 'rollback', status: 'resolved', channelId: IDS.api },
    ]);
    await person().clear(field(view));
    await person().type(field(view), 'other{Enter}');
    await settle();
    await person().click(view.getByRole('button', { name: 'Saved searches' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Rollbacks' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(searched);
    expect(field(view).value).toBe('rollback');
    view.unmount();
  });
});
