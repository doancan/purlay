/** What a person may change about their sidebar, and what it then lists: the rules, without a render (D-195). */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_PREFERENCES,
  isDefault,
  keyFor,
  parsePreferences,
  serialisePreferences,
  shownRows,
  withToggled,
  type SidebarPreferences,
  type SidebarRow,
} from './preferences';

const row = (id: string, over: Partial<SidebarRow> = {}): SidebarRow => ({
  id,
  unread: false,
  mentions: 0,
  muted: false,
  incident: false,
  ...over,
});

const rows = [
  row('quiet'),
  row('unread', { unread: true }),
  row('mentioned', { mentions: 2, unread: true }),
  row('muted', { muted: true }),
  row('muted-mentioned', { muted: true, mentions: 1, unread: true }),
  row('open'),
  row('on-fire', { incident: true }),
  row('muted-on-fire', { muted: true, incident: true }),
];

const ids = (list: readonly SidebarRow[]): string[] => list.map((entry) => entry.id);

const show = (
  over: Partial<{
    collapsed: boolean;
    unreadOnly: boolean;
    hideMuted: boolean;
    currentId: string | null;
  }> = {},
): string[] =>
  ids(
    shownRows(rows, {
      collapsed: false,
      unreadOnly: false,
      hideMuted: false,
      currentId: null,
      ...over,
    }),
  );

describe('which rows a section lists', () => {
  test('all of them, in the order they came, when nothing is asked for', () => {
    expect(show()).toEqual(ids(rows));
  });

  test('collapsed, a section keeps what needs a look: what is unread, what mentions, and where the person is', () => {
    expect(show({ collapsed: true, currentId: 'open' })).toEqual([
      'unread',
      'mentioned',
      'muted-mentioned',
      'open',
      'on-fire',
      'muted-on-fire',
    ]);
  });

  test('only unread: the same rule, and the open conversation stays whatever it is', () => {
    expect(show({ unreadOnly: true, currentId: 'quiet' })).toEqual([
      'quiet',
      'unread',
      'mentioned',
      'muted-mentioned',
      'on-fire',
      'muted-on-fire',
    ]);
  });

  test('without muted: a muted row goes unless it mentions the person, has an incident open, or is the open one', () => {
    expect(show({ hideMuted: true })).toEqual([
      'quiet',
      'unread',
      'mentioned',
      'muted-mentioned',
      'open',
      'on-fire',
      'muted-on-fire',
    ]);
    expect(show({ hideMuted: true, currentId: 'muted' })).toEqual([
      'quiet',
      'unread',
      'mentioned',
      'muted',
      'muted-mentioned',
      'open',
      'on-fire',
      'muted-on-fire',
    ]);
  });

  test('an open incident is what a glance is for: a fold and only-unread keep it, muted or not', () => {
    for (const rules of [
      { collapsed: true },
      { unreadOnly: true },
      { collapsed: true, hideMuted: true },
    ]) {
      const shown = show(rules);
      expect([shown.includes('on-fire'), shown.includes('muted-on-fire')]).toEqual([true, true]);
    }
  });

  test('the asks add up: collapsed and without muted keeps only an unread row that is not muted, or one that mentions', () => {
    expect(show({ collapsed: true, hideMuted: true })).toEqual([
      'unread',
      'mentioned',
      'muted-mentioned',
      'on-fire',
      'muted-on-fire',
    ]);
  });

  test('a row is never listed twice and the order is the one it came in', () => {
    const shown = show({ collapsed: true, unreadOnly: true, hideMuted: true, currentId: 'unread' });
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown).toEqual(ids(rows).filter((id) => shown.includes(id)));
  });
});

describe('what is remembered', () => {
  test('nothing at all reads as the defaults', () => {
    expect(parsePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(isDefault(DEFAULT_PREFERENCES)).toBe(true);
  });

  test('a saved choice comes back as it was saved', () => {
    const chosen: SidebarPreferences = {
      collapsed: ['channels', 'people'],
      hidden: ['conversations'],
      unreadOnly: true,
      channelOrder: 'activity',
      hideMuted: true,
    };
    expect(parsePreferences(serialisePreferences(chosen))).toEqual(chosen);
    expect(isDefault(chosen)).toBe(false);
  });

  test.each([
    ['not json', '{nope'],
    ['not an object', '[1,2]'],
    ['null', 'null'],
    ['a number', '7'],
    ['an empty object', '{}'],
  ])('what cannot be read (%s) is the defaults, never a throw', (_label, text) => {
    expect(parsePreferences(text)).toEqual(DEFAULT_PREFERENCES);
  });

  test('each field is taken or left on its own: one wrong value does not cost the rest', () => {
    const read = parsePreferences(
      JSON.stringify({
        collapsed: ['channels', 'nonsense', 7, 'channels'],
        hidden: ['people', 'starred', 'channels'],
        unreadOnly: 'yes',
        channelOrder: 'activity',
        hideMuted: true,
        somethingNew: 1,
      }),
    );
    // Only a section that exists, once; only a section that may be turned off.
    expect(read.collapsed).toEqual(['channels']);
    expect(read.hidden).toEqual(['people']);
    expect(read.unreadOnly).toBe(false);
    expect(read.channelOrder).toBe('activity');
    expect(read.hideMuted).toBe(true);
  });

  test('is kept per person and per workspace: two people on one machine do not share a sidebar', () => {
    expect(keyFor('user-a', 'ws-1')).not.toBe(keyFor('user-b', 'ws-1'));
    expect(keyFor('user-a', 'ws-1')).not.toBe(keyFor('user-a', 'ws-2'));
  });
});

describe('turning a section on and off', () => {
  test('toggling adds, then removes, and leaves the others alone', () => {
    const once = withToggled(['channels'], 'people');
    expect(once).toEqual(['channels', 'people']);
    expect(withToggled(once, 'people')).toEqual(['channels']);
  });
});
