/**
 * Code references in a message's words, as links into the channel's repository (D-223): a path with a
 * source extension — `src/retry.ts:14`, `apps/api/src/x.ts#L10-L20`, `retry.test.ts` in inline code —
 * and a commit's SHA.
 *
 * - **Only with a repository.** The caller passes the channel's one GitHub feed repository; without one
 *   nothing here is called. A repository that is not GitHub's shape (`GITHUB_REPOSITORY_PATTERN`) makes
 *   no link at all.
 * - **Precision over reach.** A path needs a known source extension, so a version (`1.2.3:4`), a time
 *   (`10:30`), a domain or a plain word is not one; it starts where nothing path-like is before it, so an
 *   absolute path (`/home/ci/src/a.ts`), a URL's path, an address (`a@b.ts`) or `owner/repo@sha` is never
 *   cut into a shorter reference that would point somewhere else; a first directory that is a domain
 *   (`github.com/…`) or a `node_modules` directory is not the repository's. A bare file name with no
 *   directory and no line (`Node.js`) is a reference only inside inline code, where it was marked as code
 *   by whoever wrote it. A SHA is 7–40 lower-case hex with a digit *and* a letter, standing alone: not a
 *   number, not a word like `decade`, not a colour (`#a1b2c3`), not a piece of a UUID or a longer hash.
 * - **Nothing is fetched.** Whether the file or the commit exists is GitHub's to say when the link is
 *   opened; a link that goes to GitHub's 404 costs a click, a request on render would cost every reader.
 * - **The address is built, never taken.** From the checked repository and each path segment encoded on
 *   its own; a `.` or `..` segment never matches, so the address cannot step out of the repository, and
 *   what is built still passes `SafeHref.of` and is checked to be on github.com under that repository.
 */
import { GITHUB_REPOSITORY_PATTERN } from '@purlay/types';
import { SafeHref } from './href';

/** Where the text is: prose, or inside inline code (a bare file name counts only there). */
export type CodeContext = 'prose' | 'code';

/** A reference found, where it is in the text it was found in, and the address it goes to. */
export interface CodeLink {
  /** Offset of its first character, in UTF-16 code units. */
  readonly start: number;
  /** Offset just past it. */
  readonly end: number;
  readonly href: SafeHref;
}

const REPOSITORY = new RegExp(GITHUB_REPOSITORY_PATTERN);

/** The extensions a source path ends in. A word ending in another (`example.com`, `v1.2`) is not a path. */
const EXTENSIONS = [
  'bash',
  'c',
  'cc',
  'cjs',
  'cpp',
  'cs',
  'css',
  'cts',
  'dart',
  'ex',
  'exs',
  'go',
  'gradle',
  'graphql',
  'h',
  'hpp',
  'html',
  'java',
  'js',
  'json',
  'jsx',
  'kt',
  'kts',
  'lock',
  'lua',
  'md',
  'mdx',
  'mjs',
  'mts',
  'php',
  'proto',
  'py',
  'rb',
  'rs',
  'scala',
  'scss',
  'sh',
  'sql',
  'svelte',
  'swift',
  'tf',
  'toml',
  'ts',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
];
/** Longest first, so `tsx` is tried before `ts` and the lookahead after it decides. */
const EXTENSION = [...EXTENSIONS].sort((a, b) => b.length - a.length).join('|');

/**
 * What may not come right before a reference: anything that would make it the tail of a longer word, path,
 * address, URL or hash — a letter, a digit, an invisible format character (a bidirectional control), `_`,
 * `.`, `@`, `#`, `/`, `\`, `:`, `~`, `$`, `%`, `+`, `-`.
 */
const NOT_AFTER = String.raw`(?<![\p{L}\p{N}\p{Cf}_.@#/\\:~$%+\-])`;
/** What may not come right after one: more of a word, or a further extension (`a.ts.bak`). */
const NOT_BEFORE = String.raw`(?![\p{L}\p{N}_+\-]|\.[\p{L}\p{N}_])`;
/** A segment's first character: a letter, digit, `_`, `+` or `-`, after at most one dot (`.github`). */
const HEAD = String.raw`\.?[\p{L}\p{N}_+\-]`;
const REST = String.raw`[\p{L}\p{N}_.+\-]`;
/** `:14`, `:14:3`, `:10-20`, `#L14`, `#L10-L20`, and the compiler's `(14,3)`. */
const LINE = String.raw`(?::(\d{1,7})(?::\d{1,7}|-(\d{1,7}))?|#L(\d{1,7})(?:-L(\d{1,7}))?|\((\d{1,7}),\d{1,7}\))(?![\p{L}\p{N}_])`;

/**
 * Each segment's characters exclude `/`, so the repetition splits at slashes one way only, and the scan
 * stays linear over a sixteen-thousand-character body (`code-references.test.ts` times it).
 */
const FILE = new RegExp(
  `${NOT_AFTER}((?:\\./)?(?:${HEAD}${REST}*/)*${HEAD}${REST}*?\\.(?:${EXTENSION}))${NOT_BEFORE}(?:${LINE})?`,
  'giu',
);

/** 7–40 lower-case hex standing alone, with at least one letter and one digit. */
const COMMIT = new RegExp(
  `${NOT_AFTER}(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}${NOT_BEFORE}`,
  'gu',
);

/** A directory a repository's own files are not under: installed packages. */
const NOT_THE_REPOSITORYS = 'node_modules';

const lineOf = (match: RegExpExecArray): string => {
  const [, , colon, colonEnd, hash, hashEnd, compiler] = match;
  const start = Number(colon ?? hash ?? compiler ?? 0);
  // Line 0 is no line; an end before its start is the start alone.
  if (start < 1) return '';
  const end = Number(colonEnd ?? hashEnd ?? 0);
  return end > start ? `#L${String(start)}-L${String(end)}` : `#L${String(start)}`;
};

/**
 * The address, checked on what the browser will read: https, github.com, under the repository's own
 * path. The encoding is what guarantees it; one that does not is a defect, thrown, so the body is shown
 * as typed (`render-content.tsx`) rather than linked somewhere else.
 */
const built = (url: string, under: string): SafeHref => {
  const href = SafeHref.of(url);
  const parsed = href === null ? null : new URL(href.href);
  if (
    href === null ||
    parsed?.protocol !== 'https:' ||
    parsed.host !== 'github.com' ||
    !parsed.pathname.startsWith(under)
  ) {
    throw new Error(`a code reference was built as ${url}, outside ${under}`);
  }
  return href;
};

const fileLink = (
  repository: string,
  match: RegExpExecArray,
  where: CodeContext,
): SafeHref | null => {
  const [, written = ''] = match;
  const path = written.startsWith('./') ? written.slice(2) : written;
  const segments = path.split('/');
  const [first = ''] = segments;
  const line = lineOf(match);
  if (segments.length === 1) {
    // Where a bare name lives is not known: GitHub's search finds it in the repository.
    if (where === 'prose' && line === '') return null;
    const query = encodeURIComponent(`repo:${repository} path:${path}`);
    return built(`https://github.com/search?q=${query}&type=code`, '/search');
  }
  // A dot inside the first directory is a host (`github.com/…`, `example.com/…`), not a directory.
  if (first.lastIndexOf('.') > 0 || segments.includes(NOT_THE_REPOSITORYS)) return null;
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return built(
    `https://github.com/${repository}/blob/HEAD/${encoded}${line}`,
    `/${repository}/blob/HEAD/`,
  );
};

/**
 * The code references in one run of text, in order, each with its address in `repository` (`owner/name`).
 * None when the repository is not GitHub's shape.
 */
export const codeLinksIn = (
  text: string,
  repository: string,
  where: CodeContext,
): readonly CodeLink[] => {
  if (!REPOSITORY.test(repository)) return [];
  const found: CodeLink[] = [];
  for (const match of text.matchAll(FILE)) {
    const href = fileLink(repository, match, where);
    if (href !== null) found.push({ start: match.index, end: match.index + match[0].length, href });
  }
  for (const match of text.matchAll(COMMIT)) {
    const [sha] = match;
    // Never inside a file's reference: a hex file name (`abc1234.ts`) is refused by what may follow it.
    const href = built(`https://github.com/${repository}/commit/${sha}`, `/${repository}/commit/`);
    found.push({ start: match.index, end: match.index + sha.length, href });
  }
  return found.sort((a, b) => a.start - b.start);
};
