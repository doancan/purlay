/**
 * Unsent text survives a channel switch, a reload and a closed tab.
 *
 * "Losing a half-written message on a channel switch is unforgivable in a tool people
 * live in" (`UX.md` §5). One entry per place a person can write — a channel, or one
 * thread in it — in `localStorage`, per device and with no schema, like the theme and
 * the language (D-41). Storage can be missing (a private window), full or refuse; none
 * of that is allowed to reach the composer, so every access is guarded and a failure
 * is a draft that is not remembered, not a composer that does not work.
 */
import { useEffect, type RefObject } from 'react';
import { isClaimedBy, noteStorageFailure } from '../../../data/browser-storage';
import type { Schedule } from '../../../realtime/connection';
import type { KeyValueStorage } from '../../../theme/theme';

export interface DraftStorage extends KeyValueStorage {
  removeItem(key: string): void;
  /** How many entries there are, and the name of each: what lists a person's drafts (D-215). */
  readonly length: number;
  key(index: number): string | null;
}

/**
 * The entry for one person in one place to write. A channel and a thread in it never share one,
 * and nor do two people: whoever signs in next on this browser cannot read a draft that is not
 * theirs, whatever order a sign-out and the composer's last write happen in (#694).
 */
export const draftKey = (
  userId: string,
  channelId: string,
  parentId: string | undefined,
): string =>
  parentId === undefined
    ? `purlay.draft.${userId}.${channelId}`
    : `purlay.draft.${userId}.${channelId}.${parentId}`;

export const readDraft = (storage: DraftStorage | null, key: string): string => {
  try {
    return storage?.getItem(key) ?? '';
  } catch {
    noteStorageFailure('draft-read');
    return '';
  }
};

/** An empty draft removes the entry: a person who sent what they wrote leaves nothing behind. */
export const writeDraft = (storage: DraftStorage | null, key: string, text: string): void => {
  try {
    if (text === '') storage?.removeItem(key);
    else storage?.setItem(key, text);
  } catch {
    // Not remembered; the composer carries on.
    noteStorageFailure('draft-write');
  }
};

/** A draft found in storage: where it was being written, and what. */
export interface Draft {
  readonly key: string;
  readonly channelId: string;
  /** The thread's root, for a reply being written; null for the channel. */
  readonly parentId: string | null;
  readonly text: string;
}

/**
 * Every draft of this person on this device (D-215): read from the entries' names, so nothing is kept
 * apart from the drafts themselves. Another person's on the same browser are not theirs to list (#694).
 * A storage that refuses is no drafts, said once, never an error on the screen.
 */
export const listDrafts = (storage: DraftStorage | null, userId: string): readonly Draft[] => {
  if (storage === null) return [];
  const prefix = `purlay.draft.${userId}.`;
  const found: Draft[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix) !== true) continue;
      const [channelId, parentId, extra] = key.slice(prefix.length).split('.');
      if (channelId === undefined || channelId === '' || extra !== undefined) continue;
      const text = storage.getItem(key) ?? '';
      if (text.trim() === '') continue;
      found.push({ key, channelId, parentId: parentId ?? null, text });
    }
  } catch {
    noteStorageFailure('draft-read');
    return [];
  }
  return found;
};

/** How long after the last keystroke the draft is written: often enough to lose nothing, rarely enough to cost nothing. */
export const DRAFT_DEBOUNCE_MS = 300;

/**
 * Keeps the draft of one place written while its text changes: a moment after typing stops, and for
 * certain as the composer goes. `latest` is the text at that moment, which a cleanup cannot read from a render.
 */
export const useDraftWriter = (
  place: {
    readonly storage: DraftStorage | null;
    readonly schedule: Schedule;
    readonly userId: string;
    readonly key: string;
    readonly isCurrent: () => boolean;
  },
  text: string,
  latest: RefObject<string>,
): void => {
  const { storage, schedule, userId, key, isCurrent } = place;
  // Debounced: written a moment after typing stops — while the page is still this person's.
  useEffect(() => {
    const cancel = schedule(() => {
      if (isCurrent() && isClaimedBy(storage, userId)) writeDraft(storage, key, text);
    }, DRAFT_DEBOUNCE_MS);
    return cancel;
  }, [text, key, storage, schedule, userId, isCurrent]);

  // Written for certain as the composer goes — a channel switch or a closed screen —
  // so the last keystrokes are never inside a timer that never fires. Not after a sign-out, or
  // after somebody else signed in in another tab: that would put the words back for them (#694).
  useEffect(
    () => (): void => {
      if (isCurrent() && isClaimedBy(storage, userId)) writeDraft(storage, key, latest.current);
    },
    [key, storage, userId, latest, isCurrent],
  );
};
