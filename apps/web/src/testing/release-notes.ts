/** Release notes as a test's build carries them (D-248): the file's own shape, for the versions it names. */
import type { ReleaseNotesSource } from '../features/about/release-notes-source';

const notesText = (version: string): string =>
  [
    `# Purlay v${version} — 2026-10-26`,
    '',
    '### Featured',
    '',
    '- **Editor** — It reads what you paste: a table stays a table',
    '',
    '### Added',
    '',
    '- **Messages** — Channels read as a live log with `day dividers` (D-98)',
    '- **Search** — Find by author',
    '',
    '### Fixed',
    '',
    '- **Feed** — The place is kept',
    '',
    '### Security',
    '',
    '- A bullet that names no area',
    '',
  ].join('\n');

/** A source holding the notes of these versions; every other version has none. */
export const notesFor =
  (...versions: readonly string[]): ReleaseNotesSource =>
  (version) =>
    Promise.resolve(versions.includes(version) ? notesText(version) : null);
