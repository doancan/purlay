/**
 * The palette from the keyboard: what is on offer, how a typed query narrows it, how the
 * arrows and Enter drive it, what each kind of item does, and what happens to focus. The
 * API is a fake the test writes; the router is a history it can read.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, type RenderResult } from '@testing-library/react';
import { useState } from 'react';
import type { Channel } from '@purlay/types';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  ME,
  WHEN,
  aChannel,
  aSession,
  aSignedInApi,
  NO_PROFILE,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { SessionGate } from '../session/session';
import { WorkspaceScopeProvider } from '../shell/workspace';
import { CommandPalette } from './command-palette';
import { expectFocusOn } from '../../testing/focus';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const members = (): Awaited<ReturnType<Api['members']>> => [
  { user: ME, role: 'owner', joinedAt: WHEN, profile: NO_PROFILE },
  { user: ALICE, role: 'member', joinedAt: WHEN, profile: NO_PROFILE },
  { user: BOB, role: 'member', joinedAt: WHEN, profile: NO_PROFILE },
];

/** A DM with Bob already exists; none with Alice. */
const withDm = (): Channel[] => [
  aChannel(IDS.api, 'api', { lastMessageAt: '2026-09-09T09:00:00.000Z' }),
  aChannel(IDS.deploys, 'deploys', { lastMessageAt: '2026-09-09T08:00:00.000Z' }),
  aChannel(IDS.incidents, 'incidents'),
  aChannel(IDS.browse, 'browse', { state: null }),
  aChannel(IDS.dm, null, {
    type: 'direct_message',
    peer: BOB,
    lastMessageAt: '2026-09-09T10:00:00.000Z',
  }),
  aChannel('00000000-0000-4000-8000-0000000000c9', 'secrets', { type: 'private' }),
];

const apiWith = (over: Partial<Api> = {}): Api =>
  aSignedInApi({
    members: () => Promise.resolve(members()),
    channels: () => Promise.resolve(withDm()),
    ...over,
  });

const Harness = ({ onOpen }: { readonly onOpen?: (open: boolean) => void }): React.JSX.Element => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        opener
      </button>
      <CommandPalette
        open={open}
        onOpenChange={(next) => {
          onOpen?.(next);
          setOpen(next);
        }}
      />
    </>
  );
};

interface Mounted {
  readonly view: RenderResult & { readonly world: Awaited<ReturnType<typeof renderApp>>['world'] };
  readonly input: () => HTMLInputElement;
  readonly options: () => string[];
  readonly selected: () => string | null | undefined;
  readonly here: () => string;
  readonly closed: () => boolean[];
}

/** What a screen reader gets from a row: its text without what is hidden from it (a person's avatar letters). */
const spoken = (node: Element | null): string | null => {
  if (node === null) return null;
  const copy = node.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent;
};

const mount = async (
  api: Api = apiWith(),
  path = `/w/acme/c/${IDS.api}`,
  locale: 'en' | 'tr' = 'en',
): Promise<Mounted> => {
  const closed: boolean[] = [];
  const view = await renderApp(
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={null}>
        <Harness onOpen={(next) => closed.push(next)} />
      </WorkspaceScopeProvider>
    </SessionGate>,
    { api, path, locale },
  );
  await settle();
  const input = (): HTMLInputElement => view.getByRole('combobox') as HTMLInputElement;
  return {
    view,
    input,
    options: () => view.queryAllByRole('option').map((option) => spoken(option) ?? ''),
    selected: (): string | null | undefined => {
      const id = input().getAttribute('aria-activedescendant');
      return id === null ? null : spoken(document.getElementById(id));
    },
    here: () => view.world.history.stack.at(-1) ?? '',
    closed: () => closed,
  };
};

describe('what is on offer before anything is typed', () => {
  test('is the groups in their order: the views, the recent channels, people, then settings', async () => {
    const { view, options } = await mount();
    const headings = view
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-labelledby'));
    expect(headings).toHaveLength(4);
    expect(view.getByText('Views')).toBeDefined();
    expect(options().map((text) => text.replace(/@\w+/, ''))).toEqual([
      'Open questions',
      'Inbox',
      'Saved',
      'Drafts and sent',
      'All unreads',
      'Search',
      'Feed' + 'api',
      'api',
      'deploys',
      // A public channel not joined is found, and says so.
      'browse' + 'Not joined',
      'incidents',
      'secrets',
      'Bob',
      'Alice',
      'you',
      // Every settings page this owner may open (D-146), then the choices made in place.
      'Profile',
      'Preferences',
      'Notifications',
      'Keyboard shortcuts',
      'Sessions & account',
      'General',
      'Members',
      'Invitations',
      'Integrations',
      'Audit log',
      'Data & retention',
      'Theme: System',
      'Theme: Light',
      'Theme: Dark',
      'Theme: Midnight',
      'Language: English',
      'Language: Türkçe',
    ]);
  });

  test('is a combobox that owns focus, with its listbox and its current option named', async () => {
    const { input, view } = await mount();
    const box = input();
    expectFocusOn(box);
    expect(box.getAttribute('aria-expanded')).toBe('true');
    expect(box.getAttribute('aria-controls')).toBe(view.getByRole('listbox').id);
    const first = document.getElementById(box.getAttribute('aria-activedescendant') ?? '');
    expect(first?.getAttribute('role')).toBe('option');
    expect(first?.getAttribute('aria-selected')).toBe('true');
    expect(view.getByRole('dialog').getAttribute('aria-describedby')).not.toBeNull();
  });

  test('offers the feed only when a channel is open', async () => {
    const { options } = await mount(apiWith(), '/w/acme/questions');
    expect(options().some((text) => text.startsWith('Feed'))).toBe(false);
  });

  test('passes the accessibility audit', async () => {
    const { view } = await mount();
    await expectNoAxeViolations(view.getByRole('dialog'));
  });
});

describe('a row has a tile', () => {
  test('a person has their avatar and everything else has its glyph, none of it read aloud', async () => {
    const { view } = await mount();
    const rows = view.queryAllByRole('option');
    const people = rows.filter((row) => row.textContent.includes('Bob'));
    expect(people.length).toBeGreaterThan(0);
    for (const row of people) {
      const avatar = row.querySelector('[data-avatar]');
      expect(avatar?.getAttribute('aria-hidden')).toBe('true');
      expect(avatar?.className).toContain('size-avatar-sm');
      expect(avatar?.textContent).toBe('BO');
    }
    const channel = rows.find((row) => spoken(row)?.startsWith('api') === true);
    expect(channel?.querySelector('[data-avatar]')).toBeNull();
    expect(channel?.querySelector('svg')).not.toBeNull();
    // The search field is the field at the top, a control's shape (D-110).
    expect(view.getByRole('combobox').parentElement?.className).toContain('rounded-lg');
  });
});

describe('typing', () => {
  test('narrows to what matches, best first, with the matched letters in semibold', async () => {
    const { view, input, options } = await mount();
    await person().type(input(), 'dep');
    // What matched, then the messages searched for the same words, always last.
    expect(options()).toEqual(['deploys', 'Search messages for “dep”']);
    const strong = view.getAllByRole('option')[0]?.querySelectorAll('b') ?? [];
    expect([...strong].map((node) => node.textContent).join('')).toBe('dep');
    expect(strong[0]?.className).toContain('font-semibold');
  });

  test('matches a person by their username even where their name does not', async () => {
    const { input, options } = await mount();
    await person().type(input(), 'bob');
    expect(options().some((text) => text.startsWith('Bob'))).toBe(true);
  });

  test('says so, politely, when nothing matches, and offers to search the messages instead', async () => {
    const { view, input, options } = await mount();
    await person().type(input(), 'zzz');
    expect(options()).toEqual(['Search messages for “zzz”']);
    expect(view.getAllByText('No match for “zzz”').length).toBeGreaterThan(0);
    const live = view
      .getAllByRole('status')
      .find((node) => node.textContent === 'No match for “zzz”');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    await expectNoAxeViolations(view.getByRole('dialog'));
  });

  test('Enter on the search row searches the messages for what was typed', async () => {
    const { input, here } = await mount();
    await person().type(input(), 'zzz');
    await person().keyboard('{Enter}');
    await settle();
    expect(here()).toBe('/w/acme/search?q=zzz');
  });

  test('announces how many results there are, once something is typed', async () => {
    const { view, input } = await mount();
    expect(view.getAllByRole('status').every((node) => node.textContent === '')).toBe(true);
    await person().type(input(), 'e');
    expect(
      view.getAllByRole('status').some((node) => /^\d+ results?$/.test(node.textContent)),
    ).toBe(true);
    await expectNoAxeViolations(view.getByRole('dialog'));
  });

  test('puts the current option back at the top when the query changes', async () => {
    const { input, selected, options } = await mount();
    const user = person();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.type(input(), 'a');
    expect(selected()).toBe(options()[0]);
  });
});

describe('the keyboard', () => {
  test('the arrows move the current option and wrap at both ends', async () => {
    const { selected, options, input } = await mount();
    const user = person();
    const all = options();
    expect(selected()).toBe(all[0]);
    await user.keyboard('{ArrowDown}');
    expect(selected()).toBe(all[1]);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(selected()).toBe(all.at(-1));
    await user.keyboard('{ArrowDown}');
    expect(selected()).toBe(all[0]);
    expectFocusOn(input());
  });

  test('Home and End jump to the ends without moving the caret', async () => {
    const { selected, options } = await mount();
    const user = person();
    const all = options();
    await user.keyboard('{End}');
    expect(selected()).toBe(all.at(-1));
    await user.keyboard('{Home}');
    expect(selected()).toBe(all[0]);
  });

  test('the rail’s places are found by name: the inbox, saved and search', async () => {
    const { input, here } = await mount();
    await person().type(input(), 'inbox');
    await person().keyboard('{Enter}');
    await settle();
    expect(here()).toBe('/w/acme/inbox');
  });

  test('Enter on a channel goes there and closes', async () => {
    const { input, here, closed } = await mount();
    const user = person();
    await user.type(input(), 'incid');
    await user.keyboard('{Enter}');
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.incidents}`);
    expect(closed()).toEqual([false]);
  });

  test('Enter on the open questions view goes to it', async () => {
    const { here } = await mount();
    await person().keyboard('{Enter}');
    await settle();
    expect(here()).toBe('/w/acme/questions');
  });

  test('Enter on the feed view goes to the channel that is open', async () => {
    const { input, here } = await mount(apiWith(), `/w/acme/c/${IDS.deploys}`);
    await person().type(input(), 'feed');
    await person().keyboard('{Enter}');
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.deploys}`);
  });

  test('Enter on a private channel goes there too', async () => {
    const { input, here } = await mount();
    await person().type(input(), 'secr');
    await person().keyboard('{Enter}');
    await settle();
    expect(here()).toBe('/w/acme/c/00000000-0000-4000-8000-0000000000c9');
  });

  test('an IME confirming a character is not Enter', async () => {
    const { input, here } = await mount();
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input(), { key: 'ArrowDown', isComposing: true });
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.api}`);
  });

  test('Escape closes it', async () => {
    const { closed } = await mount();
    await person().keyboard('{Escape}');
    await settle();
    expect(closed()).toEqual([false]);
  });

  test('keys other than its own are left to the input, and Tab does not leave the palette', async () => {
    const { input, view } = await mount();
    const user = person();
    await user.type(input(), 'Hello k /');
    expect(input().value).toBe('Hello k /');
    await user.tab();
    expect(view.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });
});

describe('what each kind of item does', () => {
  test('a person with a direct message already goes there without asking the server', async () => {
    const { input, here } = await mount(
      apiWith({ openDirectMessage: () => Promise.reject(new Error('must not be called')) }),
    );
    await person().type(input(), 'bob');
    await person().keyboard('{Enter}');
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.dm}`);
  });

  test('a person with none gets one made, and only then does it go there and close', async () => {
    const asked: [string, string][] = [];
    let release: (channel: Channel) => void = () => undefined;
    const { input, here, closed, view } = await mount(
      apiWith({
        openDirectMessage: (workspaceId, userId) => {
          asked.push([workspaceId, userId]);
          return new Promise<Channel>((resolve) => {
            release = resolve;
          });
        },
      }),
    );
    await person().type(input(), 'alice');
    await person().keyboard('{Enter}');
    await settle();
    expect(asked).toEqual([[IDS.workspace, IDS.alice]]);
    expect(closed()).toEqual([]);
    expect(here()).toBe(`/w/acme/c/${IDS.api}`);
    expect(view.queryByRole('combobox')).not.toBeNull();
    // A second Enter while it is working does nothing more.
    await person().keyboard('{Enter}');
    expect(asked).toHaveLength(1);
    await act(async () => {
      release(
        aChannel('00000000-0000-4000-8000-0000000000d1', null, {
          type: 'direct_message',
          peer: ALICE,
        }),
      );
      await Promise.resolve();
    });
    await settle();
    expect(here()).toBe('/w/acme/c/00000000-0000-4000-8000-0000000000d1');
    expect(closed()).toEqual([false]);
  });

  test('a direct message that could not be opened is said in words and the palette stays', async () => {
    const { input, view, closed, here } = await mount(
      apiWith({ openDirectMessage: () => Promise.reject(new ApiError(500, 'INTERNAL', 'broke')) }),
    );
    await person().type(input(), 'alice');
    await person().keyboard('{Enter}');
    await settle();
    expect(view.getByRole('alert').textContent).toBe(
      'That did not open. Something went wrong on our side. Try again in a moment.',
    );
    expect(closed()).toEqual([]);
    expect(here()).toBe(`/w/acme/c/${IDS.api}`);
    await person().type(input(), 'x');
    expect(view.queryByRole('alert')).toBeNull();
  });

  test('yourself is "you", found by your own name too, and a note to self is made like any direct message', async () => {
    const asked: string[] = [];
    const { input, here } = await mount(
      apiWith({
        openDirectMessage: (_workspace, userId) => {
          asked.push(userId);
          return Promise.resolve(
            aChannel('00000000-0000-4000-8000-0000000000d2', null, {
              type: 'direct_message',
              peer: ME,
            }),
          );
        },
      }),
    );
    await person().type(input(), 'dogan');
    await person().keyboard('{Enter}');
    await settle();
    expect(asked).toEqual([IDS.me]);
    expect(here()).toBe('/w/acme/c/00000000-0000-4000-8000-0000000000d2');
  });

  test('a public channel not joined is opened to be read, where its Join bar is', async () => {
    const { input, options, here, closed } = await mount();
    await person().type(input(), 'brow');
    expect(options()[0]).toBe('browse' + 'Not joined');
    await person().keyboard('{Enter}');
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.browse}`);
    expect(closed()).toEqual([false]);
  });

  test('a group conversation is found by the username of anybody in it, and Enter goes there (D-127)', async () => {
    const GROUP = '00000000-0000-4000-8000-0000000000c8';
    const zeynep = {
      id: '00000000-0000-4000-8000-0000000000e9',
      username: 'zed',
      displayName: 'Zeynep',
      avatarUrl: null,
    };
    const api = apiWith({
      channels: () =>
        Promise.resolve([
          ...withDm(),
          aChannel(GROUP, null, {
            type: 'direct_message',
            peer: null,
            peers: [ALICE, zeynep],
            lastMessageAt: '2026-09-09T11:00:00.000Z',
          }),
        ]),
    });
    const { view, input, options, here, closed } = await mount(api);
    // Neither name has "zed" in it: the group is found by the username alone.
    await person().type(input(), 'zed');
    expect(options()[0]).toBe('Alice, Zeynep');
    // Its tile is its faces, as in the sidebar (D-167), cut out in the selected row's colour.
    const [option] = view.getAllByRole('option');
    const face = option?.querySelector('[data-group-face]');
    expect([...(face?.querySelectorAll('[data-avatar]') ?? [])].map((a) => a.textContent)).toEqual([
      'A',
      'Z',
    ]);
    expect(face?.lastElementChild?.getAttribute('class')?.split(' ')).toContain(
      'border-accent-subtle',
    );
    await person().keyboard('{Enter}');
    await settle();
    expect(here()).toBe(`/w/acme/c/${GROUP}`);
    expect(closed()).toEqual([false]);
  });

  test('a settings page is found by its name, and Enter goes there and closes (D-146)', async () => {
    const { input, here, closed } = await mount();
    await person().type(input(), 'audit log');
    await person().keyboard('{Enter}');
    await settle();
    expect(here()).toBe('/w/acme/settings/audit');
    expect(closed()).toEqual([false]);
  });

  test('a member is offered their own settings pages and none of the workspace’s', async () => {
    const session = aSession();
    const { options } = await mount(
      apiWith({
        me: () =>
          Promise.resolve({
            ...session,
            memberships: session.memberships.map((m) => ({ ...m, role: 'member' as const })),
          }),
      }),
    );
    const offered = options();
    expect(offered).toContain('Profile');
    expect(offered).toContain('Sessions & account');
    for (const page of ['General', 'Members', 'Invitations', 'Audit log', 'Data & retention']) {
      expect(offered).not.toContain(page);
    }
  });

  test('a theme is applied at once, and the palette closes', async () => {
    const { input, view, closed } = await mount();
    await person().type(input(), 'theme: dark');
    await person().keyboard('{Enter}');
    await settle();
    expect(view.world.page.attributes['data-theme']).toBe('dark');
    expect(closed()).toEqual([false]);
  });

  test('a language is applied at once: the words change', async () => {
    const { input, view } = await mount();
    await person().type(input(), 'türkçe');
    await person().keyboard('{Enter}');
    await settle();
    expect(view.world.page.attributes['lang']).toBe('tr');
    expect(view.world.localeStorage.getItem('purlay.locale')).toBe('tr');
  });
});

describe('the pointer', () => {
  test('a click does it, without taking focus from the input', async () => {
    const { view, input, here } = await mount();
    const option = view.getByRole('option', { name: /deploys/ });
    fireEvent.mouseDown(option);
    expectFocusOn(input());
    fireEvent.click(option);
    await settle();
    expect(here()).toBe(`/w/acme/c/${IDS.deploys}`);
  });

  test('moving over an option makes it current; a pointer that has not moved changes nothing', async () => {
    const { view, selected, options } = await mount();
    const all = options();
    const [, , third, fourth] = view.getAllByRole('option');
    if (third === undefined || fourth === undefined) throw new Error('the list is too short');
    fireEvent.pointerMove(third, { clientX: 5, clientY: 5 });
    expect(selected()).toBe(all[2]);
    await person().keyboard('{ArrowDown}');
    expect(selected()).toBe(all[3]);
    // The list scrolls under a still pointer: the same coordinates arrive on another option.
    fireEvent.pointerMove(fourth, { clientX: 5, clientY: 5 });
    fireEvent.pointerMove(third, { clientX: 5, clientY: 5 });
    expect(selected()).toBe(all[3]);
    fireEvent.pointerMove(third, { clientX: 9, clientY: 9 });
    expect(selected()).toBe(all[2]);
    fireEvent.pointerMove(third, { clientX: 11, clientY: 9 });
    expect(selected()).toBe(all[2]);
  });
});

describe('focus', () => {
  test('goes back to what had it when the palette closes', async () => {
    const view = await renderApp(
      <SessionGate>
        <WorkspaceScopeProvider slug="acme" notFound={null}>
          <Harness />
        </WorkspaceScopeProvider>
      </SessionGate>,
      { api: apiWith(), path: `/w/acme/c/${IDS.api}` },
    );
    await settle();
    const opener = view.getByRole('button', { name: 'opener', hidden: true });
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('combobox')).toBeNull();
    act(() => {
      opener.focus();
    });
    await person().click(opener);
    await settle();
    expectFocusOn(view.getByRole('combobox'));
    await person().keyboard('{Escape}');
    await settle();
    expectFocusOn(opener);
  });
});

describe('in Turkish', () => {
  test('every word is Turkish, and the groups keep their order', async () => {
    const { view, input } = await mount(apiWith(), `/w/acme/c/${IDS.api}`, 'tr');
    expect(input().placeholder).toBe('Bir kanala, kişiye ya da görünüme git…');
    expect(view.getByText('Görünümler')).toBeDefined();
    expect(view.getByText('Ayarlar')).toBeDefined();
    await person().type(input(), 'zzz');
    expect(view.getAllByText('“zzz” için eşleşme yok').length).toBeGreaterThan(0);
    await expectNoAxeViolations(view.getByRole('dialog'));
  });

  test('counts results in Turkish', async () => {
    const { view, input } = await mount(apiWith(), `/w/acme/c/${IDS.api}`, 'tr');
    await person().type(input(), 'e');
    expect(view.getAllByRole('status').some((node) => /^\d+ sonuç$/.test(node.textContent))).toBe(
      true,
    );
  });
});

describe('closed', () => {
  test('renders nothing and builds nothing', async () => {
    const view = await renderApp(
      <SessionGate>
        <WorkspaceScopeProvider slug="acme" notFound={null}>
          <CommandPalette open={false} onOpenChange={() => undefined} />
        </WorkspaceScopeProvider>
      </SessionGate>,
      { api: apiWith(), path: `/w/acme/c/${IDS.api}` },
    );
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
  });
});
