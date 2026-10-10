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
import type { KeyValueStorage } from '../../theme/theme';

export interface DraftStorage extends KeyValueStorage {
  removeItem(key: string): void;
}

/** The entry for one place to write. A channel and a thread in it never share one. */
export const draftKey = (channelId: string, parentId: string | undefined): string =>
  parentId === undefined ? `purlay.draft.${channelId}` : `purlay.draft.${channelId}.${parentId}`;

export const readDraft = (storage: DraftStorage | null, key: string): string => {
  try {
    return storage?.getItem(key) ?? '';
  } catch {
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
  }
};
