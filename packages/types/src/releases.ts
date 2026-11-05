/**
 * Releases: the newest one on GitHub, as a signed-in person is told of it (`GET /api/releases/latest`,
 * `API.md` §2, D-248), and the shape of a release's notes — the screen that shows what a release did
 * reads the files `scripts/changelog.ts` judges.
 */
import { Type, type Static } from '@sinclair/typebox';

/** The repository Purlay is published from, as `owner/name`: the one place it is spelled. */
export const RELEASE_REPOSITORY = 'doancan/purlay';

/** Where a person goes to read the source and the releases. */
export const REPOSITORY_URL = `https://github.com/${RELEASE_REPOSITORY}`;

/** The licence, as the root manifest's `license` spells it; a test holds the two. */
export const LICENCE = 'AGPL-3.0-or-later';

/** A release's tag: `v` and three numbers, nothing after them. A pre-release (`v1.0.0-rc1`) is not offered. */
export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/**
 * The page of a release: only this repository's, for exactly this tag. Never an address a response chose
 * freely, so a link a person follows is built, not believed.
 */
export const releasePage = (tag: string): string => `${REPOSITORY_URL}/releases/tag/${tag}`;

export const LatestRelease = Type.Object({
  /** Three numbers, as the root manifest spells a version: the tag without its `v`. */
  version: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$' }),
  /** The release's page on GitHub: this repository's page of this version's tag, and no other. */
  url: Type.String({
    pattern: `^https://github\\.com/${RELEASE_REPOSITORY}/releases/tag/v\\d+\\.\\d+\\.\\d+$`,
  }),
  publishedAt: Type.String({ format: 'date-time' }),
});
export type LatestRelease = Static<typeof LatestRelease>;

/**
 * What About and the release-notes window read: the version this server runs, and the newest release.
 * `current` is the root manifest's version, always answered — also with the check off. `latest` is `null` where
 * the server could not ask, GitHub did not answer well, or the operator turned the check off.
 */
export const LatestReleaseAnswer = Type.Object({
  current: Type.String({ pattern: '^\\d+\\.\\d+\\.\\d+$' }),
  latest: Type.Union([LatestRelease, Type.Null()]),
});
export type LatestReleaseAnswer = Static<typeof LatestReleaseAnswer>;

/**
 * The categories of a release's notes, in the order they are listed (Keep a Changelog 1.1.0). The release
 * command judges the files with a list of its own — the scripts depend on no package — and a test holds the two.
 */
export const RELEASE_CATEGORIES = [
  'Featured',
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
] as const;

/** The notes' first line: `# Purlay v0.1.0 — 2026-10-26`. */
export const RELEASE_NOTES_HEADING = /^# Purlay v(\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/;

/** One bullet of a release's notes, as it was written and as it is drawn. */
export interface ReleaseNotesItem {
  /** What was written after the `- `, continuation lines joined: the whole bullet, as markdown. */
  readonly markdown: string;
  /** The product word in bold that starts a bullet — `**Messages** — …` — or `null` when it has none. */
  readonly area: string | null;
  /** What follows the area and its dash, as markdown; the whole bullet when there is no area. */
  readonly body: string;
}

export interface ReleaseNotesGroup {
  readonly category: (typeof RELEASE_CATEGORIES)[number];
  /** One entry per bullet, in the order they were written. */
  readonly items: readonly ReleaseNotesItem[];
}

export interface ReleaseNotes {
  readonly version: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly groups: readonly ReleaseNotesGroup[];
}

/** `**Messages** — a sentence`: an area in bold, a dash, and what it did. */
const AREA = /^\*\*([^*]+)\*\*\s+—\s+([\s\S]+)$/;

/** A bullet's text, split into its area and its words. */
export const readItem = (markdown: string): ReleaseNotesItem => {
  const found = AREA.exec(markdown);
  return found === null
    ? { markdown, area: null, body: markdown }
    : { markdown, area: found[1]?.trim() ?? null, body: found[2]?.trim() ?? markdown };
};

/**
 * What a release's notes file says: its version, its date and, per category, its bullets. A file that does not
 * start with the heading is `null`; a line that is neither a category, a bullet nor a bullet's continuation is
 * left out — judging the file is `scripts/changelog.ts`'s work, reading it is this.
 */
export const readReleaseNotes = (text: string): ReleaseNotes | null => {
  const lines = text.split('\n');
  const heading = RELEASE_NOTES_HEADING.exec(lines[0] ?? '');
  if (heading === null) return null;
  const [, version = '', date = ''] = heading;
  const groups: { category: ReleaseNotesGroup['category']; items: string[] }[] = [];
  let current: { category: ReleaseNotesGroup['category']; items: string[] } | undefined;
  for (const line of lines.slice(1)) {
    const category =
      line.startsWith('###') && /^\s/.test(line.slice(3)) ? line.slice(3).trim() : undefined;
    if (category !== undefined) {
      const known = RELEASE_CATEGORIES.find((name) => name === category);
      current = known === undefined ? undefined : { category: known, items: [] };
      if (current !== undefined) groups.push(current);
    } else if (current === undefined) {
      continue;
    } else if (line.startsWith('- ')) {
      current.items.push(line.slice(2).trim());
    } else if (line.startsWith('  ') && line.trim() !== '') {
      const last = current.items.at(-1);
      if (last !== undefined) current.items[current.items.length - 1] = `${last} ${line.trim()}`;
    }
  }
  return {
    version,
    date,
    groups: groups
      .filter((group) => group.items.length > 0)
      .map((group) => ({ category: group.category, items: group.items.map(readItem) })),
  };
};
