/** Preview candidates come from the same rendered tree on the server and in the browser. */
import { expect, test } from 'bun:test';
import { readMarkdown } from './parse';
import { webLinksOf } from './web-links';

const candidates = (content: string): readonly string[] =>
  webLinksOf(readMarkdown(content).tree, 'https://purlay.example');

test('keeps the first two distinct documents and preserves the first link’s fragment', () => {
  expect(
    candidates(
      [
        'https://docs.example/report#one',
        'https://docs.example/report#two',
        '[Other report](https://news.example/article?edition=2)',
        'https://third.example/',
      ].join('\n'),
    ),
  ).toEqual(['https://docs.example/report#one', 'https://news.example/article?edition=2']);
});

test('code does not make a preview request and an unreadable tree has no candidates', () => {
  expect(candidates('`https://code.example/`\n\n```text\nhttps://fence.example/\n```')).toEqual([]);
  expect(webLinksOf(null, 'https://purlay.example')).toEqual([]);
});

test.each([
  '> https://docs.example/report',
  '# [Report](https://docs.example/report)',
  '- https://docs.example/report',
  '| Link |\n| --- |\n| https://docs.example/report |',
])('a link the reader sees in %s remains eligible', (content) => {
  expect(candidates(content)).toEqual(['https://docs.example/report']);
});

test('existing GitHub, picture and own-instance cards do not get duplicate generic previews', () => {
  expect(
    candidates(
      [
        'https://github.com/org/repo/pull/12/files?tab=1',
        'https://www.github.com/org/repo/issues/34#comment',
        'https://pictures.example/cover.PNG?size=2',
        'https://purlay.example/w/acme/c/channel?message=id',
        'https://docs.example/article',
      ].join('\n'),
    ),
  ).toEqual(['https://docs.example/article']);
});

test('unsupported hosts, ports, credentials, schemes and long addresses spend no candidate slot', () => {
  expect(
    candidates(
      [
        'http://docs.example/',
        'https://user:password@docs.example/',
        'https://docs.example:8443/',
        'https://localhost/',
        'https://node.localhost/',
        'https://127.1/',
        'https://0x7f000001/',
        'https://[::1]/',
        `https://docs.example/${'section/'.repeat(400)}`,
        'https://public.example/one',
        'https://public.example/two',
      ].join('\n'),
    ),
  ).toEqual(['https://public.example/one', 'https://public.example/two']);
});
