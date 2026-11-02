/**
 * Where a release's notes come from, and how they are read (D-248).
 *
 * The notes of a release are the file the release was cut with (`docs/changelog/v{x.y.z}.md`), carried by the
 * build — not fetched from GitHub, so they are there on a server with no way out and are the notes of the
 * version this server runs, not of the newest one. The browser's build supplies the files
 * (`release-notes-files.ts`, which only the build can evaluate); a test supplies its own, and a page with none
 * knows no notes, which shows nothing.
 *
 * Never an error to the person, and never a false "no notes": a version the build has no file for, or a file that is
 * not that release's notes, is *no notes* — an answer, kept for the session. A source that *fails* (a chunk that
 * is gone after a redeploy, a dropped connection) is not an answer: the query errors, nothing is drawn, the failure
 * is noted on the page (`data-storage-failed`, the client's only report) and the next time the notes are asked for
 * — another screen, About — the source is tried again.
 */
import { createContext, useContext } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { readReleaseNotes, type ReleaseNotes } from '@purlay/types';
import { noteStorageFailure } from '../../data/browser-storage';
import { keys } from '../../data/keys';

/** The text of the notes of a version, or `null` where there are none; it rejects when it could not look. */
export type ReleaseNotesSource = (version: string) => Promise<string | null>;

const SourceContext = createContext<ReleaseNotesSource | null>(null);
export const ReleaseNotesSourceProvider = SourceContext.Provider;

/**
 * The notes of a version, read once for the page; `null` when there are none, `undefined` while unknown or after
 * a failure. Asks only while `enabled`.
 */
export const useReleaseNotes = (
  version: string | undefined,
  enabled = true,
): UseQueryResult<ReleaseNotes | null> => {
  const source = useContext(SourceContext);
  return useQuery({
    queryKey: keys.releaseNotes(version ?? ''),
    queryFn: async (): Promise<ReleaseNotes | null> => {
      if (source === null || version === undefined) return null;
      let text: string | null;
      try {
        text = await source(version);
      } catch (failure) {
        noteStorageFailure('release-notes-load');
        throw failure;
      }
      const notes = text === null ? null : readReleaseNotes(text);
      // A file under another version's name is not this version's notes.
      return notes !== null && notes.version === version ? notes : null;
    },
    enabled: enabled && version !== undefined,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
};
