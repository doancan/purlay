/**
 * What the palette shows: the groups in their fixed order, the best match first inside
 * each (Views and Settings in their own order), the cap, and the menu an empty query offers.
 */
import { describe, expect, test } from 'bun:test';
import { EMPTY_QUERY_RECENT, GROUPS, RESULT_CAP, rank, type PaletteItem } from './rank';

const item = (
  id: string,
  group: PaletteItem['group'],
  label: string,
  over: Partial<PaletteItem> = {},
): PaletteItem => ({
  id,
  group,
  label,
  glyph: 'channel',
  recency: '',
  run: () => undefined,
  ...over,
});

const ids = (shown: ReturnType<typeof rank>): string[] => shown.map((entry) => entry.item.id);

describe('an empty query', () => {
  const channels = Array.from({ length: 8 }, (_, n) =>
    item(`c${String(n)}`, 'channels', `chan-${String(n)}`, {
      recency: `2026-09-09T08:00:0${String(n)}.000Z`,
    }),
  );
  const people = Array.from({ length: 7 }, (_, n) =>
    item(`p${String(n)}`, 'people', `person-${String(n)}`),
  );
  const views = [item('v1', 'views', 'Open questions'), item('v2', 'views', 'Feed')];
  const settings = [
    item('s1', 'settings', 'Theme: Dark'),
    item('s2', 'settings', 'Language: English'),
  ];

  test('is a menu: every view and setting, the few most recent channels and people', () => {
    const shown = rank([...settings, ...people, ...channels, ...views], '');
    const got = ids(shown);
    expect(got.filter((id) => id.startsWith('v'))).toEqual(['v1', 'v2']);
    expect(got.filter((id) => id.startsWith('s'))).toEqual(['s1', 's2']);
    expect(got.filter((id) => id.startsWith('c'))).toHaveLength(EMPTY_QUERY_RECENT);
    expect(got.filter((id) => id.startsWith('p'))).toHaveLength(EMPTY_QUERY_RECENT);
    // Most recent first.
    expect(got.filter((id) => id.startsWith('c'))).toEqual(['c7', 'c6', 'c5', 'c4', 'c3']);
  });

  test('keeps the groups in their order whatever the order the items came in', () => {
    const shown = rank(
      [...settings, ...channels.slice(0, 1), ...views, ...people.slice(0, 1)],
      '  ',
    );
    expect(shown.map((entry) => entry.item.group)).toEqual([
      'views',
      'views',
      'channels',
      'people',
      'settings',
      'settings',
    ]);
  });

  test('shows nothing emphasised', () => {
    expect(rank(views, '').every((entry) => entry.positions.length === 0)).toBe(true);
  });
});

describe('a query', () => {
  test('keeps a settings group in the order it was given, not the alphabet’s', () => {
    const whiles = ['For 30 minutes', 'For 1 hour', 'For 2 hours', 'Until tomorrow'];
    const given = whiles.map((label, n) =>
      item(`while-${String(n)}`, 'settings', `Deep Work: ${label}`),
    );
    expect(ids(rank(given, 'deep work'))).toEqual(['while-0', 'while-1', 'while-2', 'while-3']);
    // Channels with no time are still by name.
    const named = [item('b', 'channels', 'deep-b'), item('a', 'channels', 'deep-a')];
    expect(ids(rank(named, 'deep'))).toEqual(['a', 'b']);
  });

  test('puts the best match first inside its group, then the more recent, then the alphabetical', () => {
    const shown = rank(
      [
        item('weak', 'channels', 'd-e-p', { recency: '2026-09-09T09:00:00.000Z' }),
        item('long', 'channels', 'deploys-and-more', { recency: '2026-09-09T08:00:00.000Z' }),
        item('exact', 'channels', 'dep', { recency: '2026-09-09T07:00:00.000Z' }),
        item('tieB', 'channels', 'depb', { recency: '2026-09-09T06:00:00.000Z' }),
        item('tieA', 'channels', 'depa', { recency: '2026-09-09T06:00:00.000Z' }),
      ],
      'dep',
    );
    expect(ids(shown)).toEqual(['exact', 'tieA', 'tieB', 'long', 'weak']);
  });

  test('keeps the groups in their fixed order, though a person scores better than a channel', () => {
    const shown = rank(
      [
        item('person', 'people', 'api'),
        item('channel', 'channels', 'api-gateway'),
        item('view', 'views', 'apis'),
      ],
      'api',
    );
    expect(ids(shown)).toEqual(['view', 'channel', 'person']);
  });

  test('carries the positions of the label for emphasis', () => {
    const [first] = rank([item('a', 'channels', 'deploys')], 'dpl');
    expect(first?.positions).toEqual([0, 2, 3]);
  });

  test('a keyword can match what the label does not, with nothing emphasised', () => {
    const shown = rank([item('a', 'people', 'Alice', { keywords: ['asmith'] })], 'asmi');
    expect(ids(shown)).toEqual(['a']);
    expect(shown[0]?.positions).toEqual([]);
  });

  test("a better keyword match does not remove the label's emphasis", () => {
    const [first] = rank([item('a', 'people', 'Alice', { keywords: ['alice'] })], 'ali');
    expect(first?.positions).toEqual([0, 1, 2]);
  });

  test('a keyword that matches worse than the label changes nothing', () => {
    const shown = rank([item('a', 'people', 'dep', { keywords: ['d-e-p'] })], 'dep');
    expect(shown[0]?.positions).toEqual([0, 1, 2]);
  });

  test('is capped, taking the best matches across the groups', () => {
    const many = Array.from({ length: 80 }, (_, n) =>
      item(`i${String(n)}`, 'channels', `ops-${String(n)}`),
    );
    const best = item('best', 'people', 'ops');
    const shown = rank([...many, best], 'ops');
    expect(shown).toHaveLength(RESULT_CAP);
    expect(ids(shown)).toContain('best');
  });

  test('says nothing when nothing matches', () => {
    expect(rank([item('a', 'channels', 'deploys')], 'zzz')).toEqual([]);
  });

  test('ignores the whitespace around what was typed', () => {
    expect(ids(rank([item('a', 'channels', 'deploys')], '  dep  '))).toEqual(['a']);
  });

  test('is the same list every time', () => {
    const items = Array.from({ length: 30 }, (_, n) =>
      item(`i${String(n)}`, GROUPS[n % 4] ?? 'views', `x${String(n % 5)}`),
    );
    expect(ids(rank(items, 'x'))).toEqual(ids(rank([...items], 'x')));
  });

  test('two thousand items are ranked well inside a frame', () => {
    const items = Array.from({ length: 2000 }, (_, n) =>
      item(`i${String(n)}`, 'channels', `channel-number-${String(n)}`),
    );
    const started = performance.now();
    rank(items, 'chnum');
    expect(performance.now() - started).toBeLessThan(100);
  });
});
