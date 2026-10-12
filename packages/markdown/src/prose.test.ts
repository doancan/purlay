/**
 * Where a mention can be (#330, D-101 §7 amended): the prose of the tree the client draws — not code,
 * not a link, and not glued to either. One reading for what notifies and what is highlighted.
 */
import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from './parse';
import { proseNames } from './prose';

const names = (text: string): readonly string[] => {
  const tree = parseMarkdown(text);
  if (tree === null) throw new Error(`not read: ${text}`);
  return proseNames(tree);
};

describe('names in the prose', () => {
  test.each([
    ['hey @alice', ['alice']],
    ['**@alice** and _@bob_', ['alice', 'bob']],
    ['# @alice', ['alice']],
    ['> @alice', ['alice']],
    ['- @alice\n- @bob', ['alice', 'bob']],
    ['| a |\n|---|\n| @alice |', ['alice']],
    ['line\n@alice', ['alice']],
    // A hard line break is a new line of prose: it ends whatever it follows.
    ['line\\\n@alice', ['alice']],
    ['`x`  \n@alice', ['alice']],
    ['~~@alice~~', ['alice']],
    // A backtick pair across a blank line is not code to the engine, so it is not to the server.
    ['`one\n\n@alice two`', ['alice']],
    ['@alice @alice', ['alice', 'alice']],
  ])('%j has %j', (text, found) => {
    expect(names(text)).toEqual(found);
  });

  test.each([
    ['`@alice`', 'inside inline code'],
    ['```\n@alice\n```', 'inside a fence'],
    ['[@alice](https://example.com)', 'a link label is the link’s, not an address to a person'],
    ['https://medium.com/@alice', 'inside an address'],
    ['<https://example.com/@alice>', 'inside an angle-bracketed address'],
    ['`x`@alice', 'glued to the end of a code span'],
    ['[x](https://example.com)@alice', 'glued to the end of a link'],
    ['alice@example.com', 'an e-mail address'],
  ])('%j has none (%s)', (text) => {
    expect(names(text)).toEqual([]);
  });

  test('a name in prose on either side of code is still found', () => {
    expect(names('@alice `code` @bob')).toEqual(['alice', 'bob']);
  });
});
