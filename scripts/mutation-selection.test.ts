/** Which mutations a pull request proves, and how the weekly run divides the list (`mutation-selection.ts`). */
import { describe, expect, test } from 'bun:test';
import type { Mutation } from './mutate';
import { changedIds, mergeBase, mutationsAt, parseShard, shardOf } from './mutation-selection';
import { MUTATIONS, MUTATIONS_BY_AREA } from './mutations';

const entry = (id: string, over: Partial<Mutation> = {}): Mutation => ({
  id,
  why: 'a guard is gone',
  file: 'scripts/a.ts',
  find: 'a',
  replace: 'b',
  tests: ['scripts/a.test.ts'],
  ...over,
});

describe('the ids a pull request adds or changes', () => {
  const base = [entry('a'), entry('b'), entry('c')];

  test('is empty when nothing differs', () => {
    expect(changedIds(base, [...base])).toEqual([]);
  });

  test('names an added entry', () => {
    expect(changedIds(base, [entry('a'), entry('ab'), entry('b'), entry('c')])).toEqual(['ab']);
  });

  test.each([
    ['find', { find: 'x' }],
    ['replace', { replace: 'x' }],
    ['tests', { tests: ['scripts/b.test.ts'] }],
    ['file', { file: 'scripts/b.ts' }],
    ['why', { why: 'another reason' }],
    ['equivalent', { equivalent: 'cannot change behaviour' }],
  ] as const)('names an entry whose %s changed', (_field, over) => {
    expect(changedIds(base, [entry('a'), entry('b', over), entry('c')])).toEqual(['b']);
  });

  test('names nothing for a removed entry: there is nothing left to apply', () => {
    expect(changedIds(base, [entry('a'), entry('c')])).toEqual([]);
  });

  test('names an entry that moved to another place in the list only when its text changed', () => {
    expect(changedIds(base, [entry('c'), entry('a'), entry('b')])).toEqual([]);
  });

  test('names every added entry, in the order the list has them, and a removal beside them changes nothing', () => {
    expect(changedIds(base, [entry('a'), entry('b2'), entry('c', { find: 'y' })])).toEqual([
      'b2',
      'c',
    ]);
  });

  test('is all of the list when the base has none', () => {
    expect(changedIds([], base)).toEqual(['a', 'b', 'c']);
  });
});

describe('reading the list at a commit', () => {
  test('HEAD has the list this tree has, and nothing is changed against itself', async () => {
    const atHead = await mutationsAt('HEAD');
    expect(atHead.length).toBeGreaterThan(0);
    expect(changedIds(atHead, atHead)).toEqual([]);
    expect(mergeBase('HEAD')).toMatch(/^[0-9a-f]{40}$/);
  });

  test('refuses a ref that does not exist rather than reading nothing', async () => {
    const failure = await mutationsAt('no-such-ref-anywhere').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(failure)).toContain('cannot read the list');
  });
});

describe('the shards of the weekly run', () => {
  const areas = {
    big: [entry('b1'), entry('b2'), entry('b3'), entry('b4')],
    middle: [entry('m1'), entry('m2')],
    small: [entry('s1')],
    tiny: [entry('t1')],
  };

  test('hold every entry exactly once, whatever the count', () => {
    for (const count of [1, 2, 3, 5, 9]) {
      const ids = Array.from({ length: count }, (_, at) =>
        shardOf(areas, at + 1, count).map((m) => m.id),
      ).flat();
      expect(ids.sort()).toEqual(
        Object.values(areas)
          .flat()
          .map((m) => m.id)
          .sort(),
      );
    }
  });

  test('keep an area whole and balance the shards by entries', () => {
    expect(shardOf(areas, 1, 2).map((m) => m.id)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(shardOf(areas, 2, 2).map((m) => m.id)).toEqual(['m1', 'm2', 's1', 't1']);
  });

  test('leave a shard empty when there are more shards than areas', () => {
    expect(shardOf(areas, 5, 5)).toEqual([]);
  });

  test('divide the real list with none lost or repeated', () => {
    const count = 12;
    const ids = Array.from({ length: count }, (_, at) =>
      shardOf(MUTATIONS_BY_AREA, at + 1, count).map((m) => m.id),
    ).flat();
    expect(ids.sort()).toEqual(MUTATIONS.map((m) => m.id).sort());
  });

  test('are named `index/count`, and nothing else is a shard', () => {
    expect(parseShard('2/6')).toEqual({ index: 2, count: 6 });
    for (const text of ['', '0/6', '7/6', '2', '2/', 'a/b', '1/0', '-1/3']) {
      expect(() => parseShard(text), text).toThrow('--shard wants');
    }
  });
});
