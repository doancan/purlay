/**
 * The release notes the build carries (D-248): every `docs/changelog/v{x.y.z}.md`, each its own lazy chunk, so
 * none of them is in the first load (D-196) and one is fetched only when somebody opens the window for it.
 *
 * Only the build can evaluate `import.meta.glob`, so this is the one file that does, and the one place the page
 * is handed its source (`main.tsx`); everything that reads the notes takes a `ReleaseNotesSource`.
 */
import type { ReleaseNotesSource } from './release-notes-source';

const files = import.meta.glob<string>('../../../../../docs/changelog/v*.md', {
  query: '?raw',
  import: 'default',
});

export const bundledReleaseNotes: ReleaseNotesSource = async (version) => {
  // The version is a server's word: only three numbers name a file.
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const load = files[`../../../../../docs/changelog/v${version}.md`];
  return load === undefined ? null : await load();
};
