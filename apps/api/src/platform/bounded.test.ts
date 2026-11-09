/**
 * A queue with a bound lets go of its oldest, not its newest: what has waited longest is the nearest
 * to being worth nothing, and what has just come in is what a person is waiting for.
 */
import { describe, expect, test } from 'bun:test';
import { admit, dropOldest, dropOldestOf } from './bounded';

describe('a map of waiting things, oldest first', () => {
  test('within its bound nothing goes', () => {
    const waiting = new Map([
      ['a', 1],
      ['b', 2],
    ]);
    expect(dropOldest(waiting, 2)).toEqual([]);
    expect([...waiting.keys()]).toEqual(['a', 'b']);
  });

  test('past its bound the oldest go, in the order they came, and the newest stay', () => {
    const waiting = new Map([
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 4],
    ]);
    expect(dropOldest(waiting, 2)).toEqual(['a', 'b']);
    expect([...waiting.keys()]).toEqual(['c', 'd']);
  });

  test('a bound of nothing lets everything go', () => {
    const waiting = new Map([['a', 1]]);
    expect(dropOldest(waiting, 0)).toEqual(['a']);
    expect(waiting.size).toBe(0);
  });
});

describe('a line of waiting things, oldest first', () => {
  test('within its bound nothing goes', () => {
    const line = [1, 2, 3];
    expect(dropOldestOf(line, 3)).toBe(0);
    expect(line).toEqual([1, 2, 3]);
  });

  test('past its bound the oldest go and the newest stay', () => {
    const line = [1, 2, 3, 4, 5];
    expect(dropOldestOf(line, 2)).toBe(3);
    expect(line).toEqual([4, 5]);
  });
});

describe('admitting into a line', () => {
  test('what fits goes in behind what waits, and nothing is dropped', () => {
    const line = [1, 2];
    expect(admit(line, [3], 5)).toBe(0);
    expect(line).toEqual([1, 2, 3]);
  });

  test('past the bound the oldest in line are let go, and the newcomers stay', () => {
    const line = [1, 2, 3];
    expect(admit(line, [4, 5], 4)).toBe(1);
    expect(line).toEqual([2, 3, 4, 5]);
  });

  test('a batch larger than the line keeps its newest, and everything waiting before it goes', () => {
    const line = [1, 2];
    expect(admit(line, [3, 4, 5, 6, 7], 3)).toBe(4);
    expect(line).toEqual([5, 6, 7]);
  });

  test('a bound of nothing admits nothing and lets all go', () => {
    const line = [1];
    expect(admit(line, [2, 3], 0)).toBe(3);
    expect(line).toEqual([]);
  });
});
