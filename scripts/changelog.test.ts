/**
 * The changelog is in the standard shape (D-185).
 *
 * "Write entries by category, one line each" was a sentence in a header; this is what holds it: the
 * Unreleased section and every release's notes are read by the same judge `bun run release` uses, so
 * a changelog that drifts back into prose fails the build on the change that did it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATEGORIES, NOTES_HEADING, NOTHING, problemsIn } from './changelog';

const CHANGELOG = join(import.meta.dir, '../docs/changelog');

describe('what the judge refuses', () => {
  const good =
    '### Added\n\n- **Messages** — a thing (D-1)\n\n### Fixed\n\n- **Search** — another\n';

  test('accepts the standard, and a bullet that continues on the next line', () => {
    expect(problemsIn(good)).toEqual([]);
    expect(problemsIn('### Added\n\n- **A** — long\n  and continued\n')).toEqual([]);
  });

  test('knows its categories', () => {
    expect(CATEGORIES).toEqual(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security']);
  });

  test('refuses a heading that is not a category', () => {
    expect(problemsIn('### Change — 2026-10-24: a theme\n\n- x\n')).toEqual([
      expect.stringContaining('is not a category'),
    ]);
  });

  test('refuses categories out of order, and twice', () => {
    expect(problemsIn('### Fixed\n\n- x\n\n### Added\n\n- y\n')).toEqual([
      expect.stringContaining('belongs before "### Fixed"'),
    ]);
    expect(problemsIn('### Added\n\n- x\n\n### Added\n\n- y\n')).toEqual([
      expect.stringContaining('appears twice'),
    ]);
  });

  test('refuses a category with nothing in it', () => {
    expect(problemsIn('### Added\n\n### Fixed\n\n- x\n')).toEqual([
      expect.stringContaining('"### Added" has no bullet'),
    ]);
    expect(problemsIn('### Added\n')).toEqual([expect.stringContaining('has no bullet')]);
  });

  test('refuses prose where bullets belong, above the first category and below one', () => {
    expect(problemsIn('Some words first.\n\n### Added\n\n- x\n')).toEqual([
      expect.stringContaining('text above the first category'),
    ]);
    expect(problemsIn('### Added\n\n- x\n\nA paragraph instead of a bullet.\n')).toEqual([
      expect.stringContaining('not a bullet'),
    ]);
  });

  test('refuses headings of another level', () => {
    expect(problemsIn('## Release\n\n### Added\n\n- x\n')).toEqual([
      expect.stringContaining('only "###" categories'),
    ]);
    expect(problemsIn('### Added\n\n#### Messages\n\n- x\n')).toEqual([
      expect.stringContaining('only "###" categories'),
    ]);
  });

  test('says which line', () => {
    expect(problemsIn('### Added\n\n- x\n\n### Oops\n\n- y\n')[0]).toMatch(/^line 5:/);
  });
});

/** The text under `## Unreleased`, up to the `---` that ends it. */
const unreleased = (): string => {
  const text = readFileSync(join(CHANGELOG, 'changes.md'), 'utf8');
  const start = text.indexOf('\n## Unreleased\n');
  expect(start, 'changes.md has no "## Unreleased"').toBeGreaterThan(-1);
  const rest = text.slice(start + '\n## Unreleased\n'.length);
  const end = rest.search(/^---[ \t]*$/m);
  expect(end, 'Unreleased has no "---" after it').toBeGreaterThan(-1);
  return rest.slice(0, end).trim();
};

describe('the files', () => {
  test('Unreleased is empty or in the standard shape', () => {
    const body = unreleased();
    if (body === NOTHING) return;
    expect(problemsIn(body)).toEqual([]);
  });

  const releases = readdirSync(CHANGELOG).filter((name) => /^v\d+\.\d+\.\d+\.md$/.test(name));

  test.each(releases)('%s is a release in the standard shape, under its own heading', (name) => {
    const [first = '', blank = '', ...body] = readFileSync(join(CHANGELOG, name), 'utf8').split(
      '\n',
    );
    const heading = NOTES_HEADING.exec(first);
    expect(heading, `${name}'s first line is "${first}"`).not.toBeNull();
    expect(`v${heading?.[1] ?? ''}.md`).toBe(name);
    expect(blank).toBe('');
    expect(problemsIn(body.join('\n'))).toEqual([]);
  });

  test('a version in package.json that is not 0.0.0 has its notes', () => {
    const version = /^ {2}"version":\s*"([^"]+)"/m.exec(
      readFileSync(join(import.meta.dir, '../package.json'), 'utf8'),
    )?.[1];
    expect(version).toBeDefined();
    if (version !== '0.0.0') expect(existsSync(join(CHANGELOG, `v${version ?? ''}.md`))).toBe(true);
  });

  test('the history before the first release is kept, not judged', () => {
    expect(existsSync(join(CHANGELOG, 'pre-0.1.0.md'))).toBe(true);
  });
});
