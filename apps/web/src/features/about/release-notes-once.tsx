/**
 * The release notes, once per version per browser (D-248): after an update, the first screen a signed-in person
 * opens shows what changed, and closing it — by the button, Escape or the scrim — is remembered, so the same
 * version never opens it again here, and the next one does.
 *
 * What is remembered is the version, in this browser's storage under `purlay.releaseNotesSeen`. It is the
 * device's, not the person's, so signing out does not forget it (`browser-storage.ts` forgets only what somebody
 * wrote). Storage that cannot be read shows nothing, not the window at every load: a message that cannot be
 * dismissed for good is worse than one that is missed. A server that does not say its version, a build with no
 * notes for it and notes that fail to load show nothing either — the app is never held up for them.
 */
import { useState } from 'react';
import { useClientStorage } from '../../data/storage-provider';
import { useLatestRelease } from '../../data/queries';
import type { ClientStorage } from '../../data/browser-storage';
import { noteStorageFailure } from '../../data/browser-storage';
import { ReleaseNotesDialog } from './release-notes-dialog';
import { useReleaseNotes } from './release-notes-source';

/** The version whose notes this browser has shown. */
export const RELEASE_NOTES_SEEN_KEY = 'purlay.releaseNotesSeen';

/** What is stored, or `null` — nothing, or storage that cannot be read, which `readable` tells apart. */
const seenIn = (
  storage: ClientStorage | null,
): { readonly readable: boolean; readonly version: string | null } => {
  if (storage === null) return { readable: false, version: null };
  try {
    return { readable: true, version: storage.getItem(RELEASE_NOTES_SEEN_KEY) };
  } catch {
    noteStorageFailure('release-notes-read');
    return { readable: false, version: null };
  }
};

const remember = (storage: ClientStorage | null, version: string): void => {
  try {
    storage?.setItem(RELEASE_NOTES_SEEN_KEY, version);
  } catch {
    noteStorageFailure('release-notes-write');
  }
};

export const ReleaseNotesOnce = (): React.JSX.Element | null => {
  const storage = useClientStorage();
  const version = useLatestRelease().data?.current;
  // What was stored when this page began, and what has been shown since: read once, so closing the window
  // (which stores the version) is not what makes it disappear, and a re-render never reads storage again.
  const [seen] = useState(() => seenIn(storage));
  const [closed, setClosed] = useState(false);

  const due = seen.readable && version !== undefined && seen.version !== version && !closed;
  const notes = useReleaseNotes(version, due).data;
  if (!due || notes === null || notes === undefined) return null;
  return (
    <ReleaseNotesDialog
      notes={notes}
      open
      onOpenChange={(open) => {
        if (open) return;
        remember(storage, version);
        setClosed(true);
      }}
    />
  );
};
