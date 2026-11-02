/** The newest release's schema, and the one reading of a release's notes the screen and the release command share. */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  LICENCE,
  LatestReleaseAnswer,
  RELEASE_CATEGORIES,
  RELEASE_TAG,
  REPOSITORY_URL,
  readReleaseNotes,
  releasePage,
} from './index';

describe('the answer about the newest release', () => {
  test('is a release, or null', () => {
    const release = {
      version: '1.2.3',
      url: 'https://github.com/doancan/purlay/releases/tag/v1.2.3',
      publishedAt: '2026-11-01T10:00:00Z',
    };
    expect(Value.Check(LatestReleaseAnswer, { current: '1.2.0', latest: release })).toBe(true);
    expect(Value.Check(LatestReleaseAnswer, { current: '1.2.0', latest: null })).toBe(true);
    expect(Value.Check(LatestReleaseAnswer, {})).toBe(false);
    expect(Value.Check(LatestReleaseAnswer, { latest: null })).toBe(false);
    expect(Value.Check(LatestReleaseAnswer, { current: 'dev', latest: null })).toBe(false);
    expect(
      Value.Check(LatestReleaseAnswer, {
        current: '1.2.0',
        latest: { ...release, version: '1.2' },
      }),
    ).toBe(false);
    expect(
      Value.Check(LatestReleaseAnswer, {
        current: '1.2.0',
        latest: { ...release, url: 'https://evil.test/' },
      }),
    ).toBe(false);
  });

  test('a release’s page is this repository’s page of this tag’s shape, and no other', () => {
    const at = (url: string): boolean =>
      Value.Check(LatestReleaseAnswer, {
        current: '1.2.3',
        latest: { version: '1.2.3', url, publishedAt: '2026-11-01T10:00:00Z' },
      });
    expect(at(releasePage('v1.2.3'))).toBe(true);
    expect(at('https://github.com/someone/else/releases/tag/v1.2.3')).toBe(false);
    expect(at('https://github.com/doancan/purlay')).toBe(false);
    expect(at('https://github.com.evil.test/doancan/purlay/releases/tag/v1.2.3')).toBe(false);
    expect(at(`${releasePage('v1.2.3')}?x=1`)).toBe(false);
  });

  test('names the licence as the manifest does', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, '../../../package.json'), 'utf8'),
    ) as { license?: string };
    expect(LICENCE).toBe(manifest.license ?? 'no licence in the manifest');
  });

  test('names the repository once, and a tag is three numbers behind a v', () => {
    expect(REPOSITORY_URL).toBe('https://github.com/doancan/purlay');
    expect(RELEASE_TAG.test('v1.0.0')).toBe(true);
    for (const tag of ['1.0.0', 'v1.0', 'v1.0.0-rc1', 'v1.0.0\n', 'xv1.0.0', 'v1.0.0.1']) {
      expect(RELEASE_TAG.test(tag)).toBe(false);
    }
  });
});

describe('reading a release’s notes', () => {
  const text = [
    '# Purlay v1.2.3 — 2026-11-01',
    '',
    '### Added',
    '',
    '- **Search** — find by `author:` (D-1)',
    '- **Threads** — a long one',
    '  continued here',
    '',
    '### Fixed',
    '',
    '- **Feed** — scroll stays',
    '',
  ].join('\n');

  test('gives the version, the date and the bullets of each category in order', () => {
    expect(readReleaseNotes(text)).toEqual({
      version: '1.2.3',
      date: '2026-11-01',
      groups: [
        {
          category: 'Added',
          items: [
            '**Search** — find by `author:` (D-1)',
            '**Threads** — a long one continued here',
          ],
        },
        { category: 'Fixed', items: ['**Feed** — scroll stays'] },
      ],
    });
  });

  test('is null without the heading, and leaves out what is not a category or a bullet', () => {
    expect(readReleaseNotes('### Added\n\n- x\n')).toBeNull();
    expect(readReleaseNotes('')).toBeNull();
    const odd =
      '# Purlay v1.0.0 — 2026-01-01\n\nstray\n### Notes\n\n- not kept\n### Added\n\n  orphan\nprose\n- kept\n### Fixed\n';
    expect(readReleaseNotes(odd)).toEqual({
      version: '1.0.0',
      date: '2026-01-01',
      groups: [{ category: 'Added', items: ['kept'] }],
    });
  });

  test('reads every release this repository has published, and finds a bullet in each', () => {
    const directory = join(import.meta.dir, '../../../docs/changelog');
    const files = readdirSync(directory).filter((name) => /^v\d+\.\d+\.\d+\.md$/.test(name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const notes = readReleaseNotes(readFileSync(join(directory, file), 'utf8'));
      expect(notes?.version).toBe(file.slice(1, -3));
      expect(notes?.groups.length).toBeGreaterThan(0);
      for (const group of notes?.groups ?? []) expect(RELEASE_CATEGORIES).toContain(group.category);
    }
  });
});
