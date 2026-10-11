/**
 * What the server records about a body when it is written (`SCHEMA.md` §6.4).
 */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { GITHUB_LINKS_PER_MESSAGE_MAX, TextMetadata } from '@purlay/types';
import { metadataOf } from './metadata';
import { parseMarkdown } from './parse';

const of = (text: string): TextMetadata => metadataOf(parseMarkdown(text));

describe('code languages', () => {
  test('in order, an unlabelled fence as empty', () => {
    expect(of('```ts\na\n```\n\ntext\n\n```\nb\n```').codeLanguages).toEqual(['ts', '']);
  });

  test('absent when there is no fence', () => {
    expect(of('just `inline` code')).toEqual({});
  });
});

describe('code only', () => {
  test('a body that is one fence', () => {
    expect(of('```sql\nselect 1\n```')).toEqual({ codeLanguages: ['sql'], isCodeOnly: true });
  });

  test('not a fence with a sentence, nor two fences', () => {
    expect(of('look:\n\n```sql\nselect 1\n```').isCodeOnly).toBeUndefined();
    expect(of('```\na\n```\n\n```\nb\n```').isCodeOnly).toBeUndefined();
  });
});

describe('GitHub links', () => {
  test('pull requests and issues, written or bare, in the order they appear, canonical', () => {
    expect(
      of(
        'see https://github.com/o/r/pull/12 and [the bug](http://www.github.com/o/r/issues/3#issuecomment-1)',
      ).githubLinks,
    ).toEqual(['https://github.com/o/r/pull/12', 'https://github.com/o/r/issues/3']);
  });

  test('one address twice is one link', () => {
    expect(
      of('https://github.com/o/r/pull/1 https://github.com/o/r/pull/1/files').githubLinks,
    ).toEqual(['https://github.com/o/r/pull/1']);
  });

  test('not a repository, a commit, another host, or an address inside code', () => {
    expect(
      of(
        'https://github.com/o/r https://github.com/o/r/commit/abc https://gitlab.com/o/r/pull/1 https://github.com.evil.example/o/r/pull/1 `https://github.com/o/r/pull/9`',
      ),
    ).toEqual({});
  });

  test('at most the limit, the rest left as ordinary links', () => {
    const body = Array.from(
      { length: GITHUB_LINKS_PER_MESSAGE_MAX + 1 },
      (_, n) => `https://github.com/o/r/pull/${String(n + 1)}`,
    ).join(' ');
    const links = of(body).githubLinks ?? [];
    expect(links).toHaveLength(GITHUB_LINKS_PER_MESSAGE_MAX);
    expect(links.at(-1)).toBe(
      `https://github.com/o/r/pull/${String(GITHUB_LINKS_PER_MESSAGE_MAX)}`,
    );
  });
});

describe('a body shown as typed', () => {
  test('records nothing', () => {
    expect(metadataOf(null)).toEqual({});
  });
});

test('whatever is recorded is the contract’s shape', () => {
  for (const body of ['```ts\na\n```', 'https://github.com/o/r/pull/1', 'x']) {
    expect(Value.Check(TextMetadata, of(body))).toBe(true);
  }
});

describe('found wherever they are', () => {
  test('a fence inside a list item or a quotation is a code language', () => {
    expect(
      of('- step\n\n  ```sh\n  bun test\n  ```\n\n> ```sql\n> select 1\n> ```').codeLanguages,
    ).toEqual(['sh', 'sql']);
  });

  test('a GitHub link in a heading, a quotation or a table cell is recorded', () => {
    expect(
      of(
        '# https://github.com/o/r/pull/1\n\n> https://github.com/o/r/pull/2\n\n| a |\n|---|\n| https://github.com/o/r/pull/3 |\n\n---',
      ).githubLinks,
    ).toEqual([
      'https://github.com/o/r/pull/1',
      'https://github.com/o/r/pull/2',
      'https://github.com/o/r/pull/3',
    ]);
  });
});
