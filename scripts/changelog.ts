/**
 * The shape of a changelog entry (D-185; the format is Keep a Changelog 1.1.0).
 *
 * A release's notes are categories of one-line bullets — Added, Changed, Deprecated, Removed, Fixed,
 * Security — so that a person can scan what a version did in two minutes, not read a transcript. The
 * shape lives here so that the command that cuts a release (`scripts/release.ts`) and the test that
 * holds the files (`scripts/changelog.test.ts`) judge the same thing.
 */

/** The categories, in the order a release lists them. */
export const CATEGORIES = [
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
] as const;

/** What Unreleased says while it holds nothing. */
export const NOTHING = '_Nothing yet._';

/**
 * What is wrong with the body of an Unreleased section or of a release's notes, one line per
 * problem; empty when it is the standard. The body is what is under the `##` heading, without it.
 *
 * - every `###` heading is a category, once, and in the order of `CATEGORIES`;
 * - nothing sits above the first category, and no heading of another level appears;
 * - a category holds bullets (`- `), with a continuation indented two spaces under the bullet it
 *   continues, and is not empty.
 */
export const problemsIn = (body: string): readonly string[] => {
  const problems: string[] = [];
  const seen: string[] = [];
  // undefined: nothing seen yet; UNKNOWN: under a heading that was already reported, so its bullets
  // are not reported a second time.
  const UNKNOWN = '';
  let current: string | undefined;
  let bullets = 0;

  const closeCategory = (): void => {
    if (current !== undefined && current !== UNKNOWN && bullets === 0)
      problems.push(`"### ${current}" has no bullet under it`);
  };

  for (const [index, line] of body.split('\n').entries()) {
    const where = `line ${String(index + 1)}`;
    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading !== null) {
      const [, hashes = '', title = ''] = heading;
      if (hashes !== '###') {
        problems.push(
          `${where}: a "${hashes}" heading ("${title}"); only "###" categories belong here`,
        );
        continue;
      }
      closeCategory();
      const category = CATEGORIES.find((name) => name === title);
      if (category === undefined) {
        problems.push(`${where}: "### ${title}" is not a category (${CATEGORIES.join(', ')})`);
        current = UNKNOWN;
        bullets = 0;
        continue;
      }
      if (seen.includes(category)) problems.push(`${where}: "### ${category}" appears twice`);
      const later = seen.filter(
        (name) =>
          CATEGORIES.indexOf(category) < CATEGORIES.indexOf(name as (typeof CATEGORIES)[number]),
      );
      if (later.length > 0)
        problems.push(`${where}: "### ${category}" belongs before "### ${later.join('", "### ')}"`);
      seen.push(category);
      current = category;
      bullets = 0;
      continue;
    }
    if (line.trim() === '') continue;
    if (current === undefined) {
      problems.push(`${where}: text above the first category: "${line.trim().slice(0, 60)}"`);
      continue;
    }
    if (line.startsWith('- ')) bullets += 1;
    else if (!line.startsWith('  '))
      problems.push(
        `${where}: not a bullet or the continuation of one: "${line.trim().slice(0, 60)}"`,
      );
  }
  closeCategory();
  return problems;
};

/** The release notes' first line: `# Purlay v0.1.0 — 2026-10-26`. */
export const NOTES_HEADING = /^# Purlay v(\d+\.\d+\.\d+) — (\d{4}-\d{2}-\d{2})$/;
