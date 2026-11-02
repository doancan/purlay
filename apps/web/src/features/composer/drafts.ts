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
import { noteStorageFailure } from '../../data/browser-storage';
import type { KeyValueStorage } from '../../theme/theme';

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
