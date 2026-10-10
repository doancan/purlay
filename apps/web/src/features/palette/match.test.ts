/**
 * What a typed query matches, and how well: the four tiers, their order, the positions
 * that come back for emphasis, and the inputs that must not match at all.
 */
import { describe, expect, test } from 'bun:test';
import { matchText } from './match';

const score = (query: string, text: string): number => matchText(query, text)?.score ?? -1;

describe('nothing typed', () => {
  test('matches everything with no emphasis', () => {
    expect(matchText('', 'deploys')).toEqual({ score: 0, positions: [] });
  });
});

describe('the tiers', () => {
  test('a name that starts with the query is the strongest, and its letters are the first', () => {
    expect(matchText('dep', 'deploys')?.positions).toEqual([0, 1, 2]);
  });

  test('a word inside the name comes next, found at the start of the word', () => {
    expect(matchText('ops', 'team-ops')?.positions).toEqual([5, 6, 7]);
    expect(matchText('ops', 'incident ops')?.positions).toEqual([9, 10, 11]);
    expect(matchText('ops', 'a_ops')?.positions).toEqual([2, 3, 4]);
  });

  test('a contiguous run in the middle of a word comes after that', () => {
    expect(matchText('ploy', 'deploys')?.positions).toEqual([2, 3, 4, 5]);
  });

  test('letters in order, spread across the name, are the weakest, and say where', () => {
    expect(matchText('dpl', 'deploys')?.positions).toEqual([0, 2, 3]);
  });

  test('prefix beats word beats contains beats subsequence', () => {
    expect(score('ops', 'ops-room')).toBeGreaterThan(score('ops', 'team-ops'));
    expect(score('ops', 'team-ops')).toBeGreaterThan(score('ops', 'devops'));
    expect(score('ops', 'devops')).toBeGreaterThan(score('ops', 'o-p-s'));
  });

  test('inside a tier the shorter name wins: what was typed is closer to it', () => {
    expect(score('api', 'api')).toBeGreaterThan(score('api', 'api-gateway'));
    expect(score('ops', 'team-ops')).toBeGreaterThan(score('ops', 'team-ops-and-more'));
  });

  test('packed letters beat spread ones', () => {
    expect(score('dpl', 'dpxl')).toBeGreaterThan(score('dpl', 'dxxxpxxxl'));
  });

  test('a tier is never crossed by length: a long prefix still beats a short word match', () => {
    expect(score('a', `a${'x'.repeat(2000)}`)).toBeGreaterThan(score('a', 'b-a'));
  });
});

describe('what does not match', () => {
  test.each([
    ['xyz', 'deploys'],
    ['sdp', 'deploys'],
    ['deploysx', 'deploys'],
    ['a', ''],
  ])('%s against %j', (query, text) => {
    expect(matchText(query, text)).toBeNull();
  });
});

describe('case and unusual text', () => {
  test('never matters', () => {
    expect(matchText('DEP', 'Deploys')?.positions).toEqual([0, 1, 2]);
    expect(matchText('dep', 'DEPLOYS')?.positions).toEqual([0, 1, 2]);
  });

  test("a person's name matches by its parts", () => {
    expect(matchText('ada', 'Ada Lovelace')?.positions).toEqual([0, 1, 2]);
    expect(matchText('love', 'Ada Lovelace')?.positions).toEqual([4, 5, 6, 7]);
  });

  test('a query of regular-expression characters is only characters', () => {
    expect(matchText('.*', 'a.*b')?.positions).toEqual([1, 2]);
    expect(matchText('(', 'deploys')).toBeNull();
  });

  test('is linear: ten thousand letters against ten thousand letters', () => {
    const text = 'ab'.repeat(5000);
    const started = performance.now();
    expect(matchText('b'.repeat(6000), text)).toBeNull();
    expect(matchText('ab'.repeat(40), text)?.positions).toHaveLength(80);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
