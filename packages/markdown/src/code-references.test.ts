/**
 * Code references as links into the channel's repository (D-223): what is one, what is not, and that
 * the address is built from the repository and the encoded path and nothing else.
 */
import { describe, expect, test } from 'bun:test';
import { codeLinksIn, type CodeContext } from './code-references';

const REPO = 'acme/api';
const BLOB = `https://github.com/${REPO}/blob/HEAD/`;

/** Each reference as the text it covers and the address it goes to. */
const links = (
  text: string,
  where: CodeContext = 'prose',
  repository = REPO,
): (readonly [string, string])[] =>
  codeLinksIn(text, repository, where).map(
    (link) => [text.slice(link.start, link.end), link.href.href] as const,
  );

describe('a path with a source extension', () => {
  test.each([
    ['see src/retry.ts:14', 'src/retry.ts:14', `${BLOB}src/retry.ts#L14`],
    ['apps/api/src/x.ts#L10-L20', 'apps/api/src/x.ts#L10-L20', `${BLOB}apps/api/src/x.ts#L10-L20`],
    ['apps/api/src/x.ts#L10', 'apps/api/src/x.ts#L10', `${BLOB}apps/api/src/x.ts#L10`],
    ['src/a.ts:10-20', 'src/a.ts:10-20', `${BLOB}src/a.ts#L10-L20`],
    ['at go (src/retry.ts:14:7)', 'src/retry.ts:14:7', `${BLOB}src/retry.ts#L14`],
    ['src/x.ts(14,5): error TS2322', 'src/x.ts(14,5)', `${BLOB}src/x.ts#L14`],
    ['changed apps/web/src/main.tsx', 'apps/web/src/main.tsx', `${BLOB}apps/web/src/main.tsx`],
    ['./src/a.ts:3', './src/a.ts:3', `${BLOB}src/a.ts#L3`],
    ['.github/workflows/ci.yml', '.github/workflows/ci.yml', `${BLOB}.github/workflows/ci.yml`],
    ['docs/UX.md', 'docs/UX.md', `${BLOB}docs/UX.md`],
    ['lib/Foo.Bar.java:9', 'lib/Foo.Bar.java:9', `${BLOB}lib/Foo.Bar.java#L9`],
    ['src/a.test.ts', 'src/a.test.ts', `${BLOB}src/a.test.ts`],
  ])('%s', (text, covered, href) => {
    expect(links(text)).toEqual([[covered, href]]);
  });

  test.each([
    ['a full stop', 'Look at src/a.ts.', 'src/a.ts'],
    ['a comma', 'src/a.ts:4, then', 'src/a.ts:4'],
    ['parentheses', '(src/a.ts)', 'src/a.ts'],
    ['quotes', '"src/a.ts:2"', 'src/a.ts:2'],
    ['a question mark', 'src/a.ts:2?', 'src/a.ts:2'],
    ['a colon', 'src/a.ts: broken', 'src/a.ts'],
    ['a Turkish suffix', "src/retry.ts:14'te hata var", 'src/retry.ts:14'],
    ['a typographic apostrophe', 'src/retry.ts’de', 'src/retry.ts'],
  ])('ends before %s', (_, text, covered) => {
    expect(links(text).map(([text]) => text)).toEqual([covered]);
  });

  test('Turkish letters in a path are kept, encoded', () => {
    expect(links('Hata src/çekirdek/şema.ts:12 içinde')).toEqual([
      ['src/çekirdek/şema.ts:12', `${BLOB}src/%C3%A7ekirdek/%C5%9Fema.ts#L12`],
    ]);
  });

  test('several in one text, in order, with where each is', () => {
    const text = 'a/b.ts:1 and c/d.py#L2 and e/f.go';
    expect(codeLinksIn(text, REPO, 'prose').map(({ start, end }) => [start, end])).toEqual([
      [0, 8],
      [13, 22],
      [27, 33],
    ]);
  });

  test('line 0 is no line; an end before its start is the start alone', () => {
    expect(links('src/a.ts:0')).toEqual([['src/a.ts:0', `${BLOB}src/a.ts`]]);
    expect(links('src/a.ts:20-10')).toEqual([['src/a.ts:20-10', `${BLOB}src/a.ts#L20`]]);
    expect(links('src/a.ts#L5-L5')).toEqual([['src/a.ts#L5-L5', `${BLOB}src/a.ts#L5`]]);
  });

  test('a line glued to a word is not a line: the path alone is the reference', () => {
    expect(links('src/a.ts:14abc')).toEqual([['src/a.ts', `${BLOB}src/a.ts`]]);
  });
});

describe('a bare file name', () => {
  const search = (name: string): string =>
    `https://github.com/search?q=${encodeURIComponent(`repo:${REPO} path:${name}`)}&type=code`;

  test('in inline code, found by GitHub search in the repository: where it lives is not known', () => {
    expect(links('retry.test.ts', 'code')).toEqual([['retry.test.ts', search('retry.test.ts')]]);
  });

  test('in prose, only with a line', () => {
    expect(links('see retry.ts:14')).toEqual([['retry.ts:14', search('retry.ts')]]);
    expect(links('I like Node.js and Chart.js')).toEqual([]);
    expect(links('Node.js', 'code')).toHaveLength(1);
  });
});

describe('a commit', () => {
  const commit = (sha: string): string => `https://github.com/${REPO}/commit/${sha}`;

  test.each([
    ['fixed in abc1234', 'abc1234'],
    [
      'reverts 0123456789abcdef0123456789abcdef01234567.',
      '0123456789abcdef0123456789abcdef01234567',
    ],
    ['(9f8e7d6)', '9f8e7d6'],
    ['abc1234’te düzeldi', 'abc1234'],
  ])('%s', (text, sha) => {
    expect(links(text)).toEqual([[sha, commit(sha)]]);
  });

  test('in inline code too', () => {
    expect(links('git show abc1234', 'code')).toEqual([['abc1234', commit('abc1234')]]);
  });

  test.each([
    ['six characters', 'abc123'],
    ['forty-one characters', `${'a1'.repeat(20)}b`],
    ['only digits', 'build 1234567'],
    ['only letters', 'a decade, a facade, deadbeef'],
    ['upper case', 'ABC1234'],
    ['a colour', 'color: #a1b2c3d'],
    ['a piece of a UUID', '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b'],
    ['a longer hash', `sha256:${'ab12'.repeat(16)}`],
    ['owner/repo@sha', 'acme/web@abc1234'],
    ['a URL path', 'https://example.com/abc1234'],
    ['the end of a word', 'xabc1234'],
    ['a hex literal', '0x1f2e3d4c'],
    ['a file name', 'abc1234.go'],
  ])('not %s', (_, text) => {
    expect(links(text)).toEqual([]);
  });
});

describe('what is not a reference', () => {
  test.each([
    ['a version and a number', 'upgraded to 1.2.3:4'],
    ['a time', 'at 10:30 tomorrow'],
    ['a date', '2026-10-31'],
    ['a domain', 'see example.com and github.io'],
    ['a domain with a path', 'github.com/acme/api/blob/main/src/a.ts'],
    ['plain words', 'the retry logic and/or the backoff'],
    ['a path with no source extension', 'src/utils and bin/run:12'],
    ['a further extension', 'src/a.ts.bak'],
    ['an extension glued to a word', 'src/a.tsx2 src/a.ts-old'],
    ['an absolute path', 'at /home/ci/work/api/src/retry.ts:14:7'],
    ['a Windows path', 'C:\\work\\src\\retry.ts:14'],
    ['a URL', 'https://example.com/src/a.ts'],
    ['an address', 'mail ops@acme.ts'],
    ['an installed package', 'node_modules/react/index.js:12'],
    ['a step out of the repository', '../secrets/a.ts and src/../../x.ts and src/./a.ts'],
    ['a home directory', '~/src/a.ts'],
    ['a variable', '$HOME/a.ts'],
    ['the tail after a bidirectional control', 'src/a‮gnp.ts abc⁦abc1234'],
    ['an empty text', ''],
  ])('%s', (_, text) => {
    expect(links(text)).toEqual([]);
    expect(links(text, 'code')).toEqual([]);
  });
});

describe('the address is built from the repository and the path, and nothing else', () => {
  test.each([
    '',
    'acme',
    'acme/..',
    'acme/.',
    '-acme/api',
    'acme/api/x',
    'javascript:alert(1)//a/b',
  ])('a repository that is not GitHub’s shape makes no link: %j', (repository) => {
    expect(links('src/a.ts:1 abc1234', 'code', repository)).toEqual([]);
  });

  test('a repository with GitHub’s characters is kept as it is', () => {
    expect(links('src/a.ts', 'prose', 'My-Org/api.v2_x')).toEqual([
      ['src/a.ts', 'https://github.com/My-Org/api.v2_x/blob/HEAD/src/a.ts'],
    ]);
  });

  test('characters that mean something in an address are encoded, segment by segment', () => {
    expect(links('src/a+b/c+d.ts')).toEqual([['src/a+b/c+d.ts', `${BLOB}src/a%2Bb/c%2Bd.ts`]]);
  });

  test('every address is https on github.com, under the repository', () => {
    const hostile = [
      'src/%2e%2e/%2e%2e/x.ts',
      'src/..%2f..%2fx.ts',
      'src/a.ts#L1"onmouseover=alert(1)',
      'javascript:src/a.ts',
      'src/<script>.ts',
      'src/a.ts?x=1',
      '//evil.example/a.ts',
      'src/a\u202Egnp.ts',
      `src/${'a/'.repeat(200)}b.ts`,
    ].join(' ');
    for (const where of ['prose', 'code'] as const) {
      const found = codeLinksIn(hostile, REPO, where);
      // Some of them are references (`src/a.ts#L1`, `src/a.ts`): the loop below is not over nothing.
      expect(found.length).toBeGreaterThan(1);
      for (const link of found) {
        const url = new URL(link.href.href);
        expect(url.protocol).toBe('https:');
        expect(url.host).toBe('github.com');
        expect(url.pathname.startsWith(`/${REPO}/`) || url.pathname === '/search').toBe(true);
        expect(url.pathname).not.toContain('..');
      }
    }
  });
});

describe('the scan is linear', () => {
  test.each([
    ['one long word of segments', 'a/'.repeat(8_000)],
    ['one long dotted word', 'a.'.repeat(8_000)],
    ['hex that never stands alone', 'a1'.repeat(8_000)],
    ['words of hex', 'abc1234 '.repeat(2_000)],
    ['paths', 'src/a.ts:1 '.repeat(1_450)],
  ])('%s, sixteen thousand characters, in well under a frame', (_, text) => {
    const started = performance.now();
    codeLinksIn(text, REPO, 'code');
    expect(performance.now() - started).toBeLessThan(100);
  });
});
