import { describe, expect, test } from 'bun:test';
import {
  EMOJI_SHORTCODES,
  SHORTCODES_MAX,
  insertShortcode,
  shortcodeKey,
  shortcodeNamed,
  suggestShortcodes,
} from './emoji-names';

describe('suggestShortcodes', () => {
  test('a name that starts with the query comes before one that only contains it', () => {
    const found = suggestShortcodes('hea').map((entry) => entry.name);
    expect(found[0]).toBe('heart');
    expect(found.indexOf('heart_eyes')).toBeLessThan(found.indexOf('broken_heart'));
  });

  test('no case and no Turkish marks are needed to find a name', () => {
    expect(suggestShortcodes('SMİL')[0]?.name).toBe('smile');
    expect(suggestShortcodes('TAD')[0]?.name).toBe('tada');
  });

  test('the list is bounded and the same letters give the same list', () => {
    const first = suggestShortcodes('sm');
    expect(first.length).toBeLessThanOrEqual(SHORTCODES_MAX);
    expect(suggestShortcodes('sm')).toEqual(first);
  });

  test('a name typed out in full, matching nothing else, offers nothing left to complete', () => {
    expect(suggestShortcodes('tada')).toEqual([]);
  });

  test('nothing matches nonsense', () => {
    expect(suggestShortcodes('zzzzqq')).toEqual([]);
  });
});

describe('the table', () => {
  test('every name is lower case and written with letters, digits, underscores, plus or minus', () => {
    for (const entry of EMOJI_SHORTCODES) expect(entry.name).toMatch(/^[a-z0-9_+-]+$/);
  });

  test('a name is there once, and an emoji has a name', () => {
    const names = EMOJI_SHORTCODES.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of EMOJI_SHORTCODES) expect(entry.emoji).not.toBe('');
  });
});

describe('shortcodeNamed', () => {
  test('a name written out is its emoji, without case; anything else is nothing', () => {
    expect(shortcodeNamed('tada')).toBe('🎉');
    expect(shortcodeNamed('TADA')).toBe('🎉');
    expect(shortcodeNamed('nosuchname')).toBeUndefined();
  });
});

describe('insertShortcode', () => {
  test('the emoji replaces the colon and what was typed after it, and the caret moves past it', () => {
    const query = { start: 5, query: 'ta' };
    expect(insertShortcode('done :ta and more', query, '🎉')).toEqual({
      text: 'done 🎉 and more',
      caret: 'done 🎉'.length,
    });
  });
});

describe('shortcodeKey', () => {
  const press = (
    key: string,
    extra: Partial<Record<'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {},
  ): Parameters<typeof shortcodeKey>[0] => ({
    key,
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...extra,
  });
  const choices = suggestShortcodes('sm');

  test('arrows move round the list, in both directions', () => {
    expect(shortcodeKey(press('ArrowDown'), 'sm', choices, 0)).toBe(1);
    expect(shortcodeKey(press('ArrowUp'), 'sm', choices, 0)).toBe(choices.length - 1);
    expect(shortcodeKey(press('ArrowDown'), 'sm', choices, choices.length - 1)).toBe(0);
  });

  test("Enter and Tab choose the current one; with a modifier they are not the list's", () => {
    expect(shortcodeKey(press('Enter'), 'sm', choices, 1)).toEqual(choices[1] ?? null);
    expect(shortcodeKey(press('Tab'), 'sm', choices, 0)).toEqual(choices[0] ?? null);
    expect(shortcodeKey(press('Enter', { shiftKey: true }), 'sm', choices, 0)).toBeNull();
    expect(shortcodeKey(press('Enter', { metaKey: true }), 'sm', choices, 0)).toBeNull();
  });

  test('Esc closes, and any other key is left to the box', () => {
    expect(shortcodeKey(press('Escape'), 'sm', choices, 0)).toBe('close');
    expect(shortcodeKey(press('a'), 'sm', choices, 0)).toBeNull();
  });

  test("with no list showing only a closing colon on a whole name is the list's", () => {
    expect(shortcodeKey(press('Enter'), 'tada', [], 0)).toBeNull();
    expect(shortcodeKey(press(':'), 'tada', [], 0)).toEqual({ name: 'tada', emoji: '🎉' });
    expect(shortcodeKey(press(':'), 'nosuch', [], 0)).toBeNull();
  });
});
