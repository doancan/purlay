/**
 * The page's `localStorage`, as one port — and the one place that knows which of its keys
 * belong to a person.
 *
 * Drafts, the channel a person was last in and the messages still in flight are all
 * *somebody's*: what they typed, where they were, what they sent. They live in the
 * browser, so on a shared machine the next person to sign in would find them, and a draft
 * is keyed by channel and thread ids alone — user B opening the same direct message would
 * see user A's unsent words. Signing out therefore removes every key that carries
 * personal text (`forgetPersonalData`), and the theme and language, which are the
 * *device's*, stay.
 *
 * Absent, the browser's is looked up when asked for and not when this file loads, because
 * the build prerenders the shell with no `window` (D-50), and reading the property can
 * itself throw when storage is blocked.
 */
export interface ClientStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

/** The keys that hold what a person wrote or where they were. Anything else on the page is the device's. */
export const PERSONAL_PREFIXES = [
  'purlay.draft.',
  'purlay.lastChannel.',
  'purlay.pending.',
] as const;

const noted = new Set<string>();

/**
 * Storage failing is deliberately silent to the person — a draft that is not remembered is
 * not worth a toast — but silent to everyone is how "my drafts never survive a reload"
 * becomes a mystery. So the first failure of each kind leaves one inspectable note on the
 * page: `<html data-storage-failed="draft-write last-channel-read">`. (There is no
 * `console` in the client; logging is not a thing this code base does from the browser.)
 */
export const noteStorageFailure = (where: string): void => {
  if (noted.has(where)) return;
  noted.add(where);
  try {
    const root = document.documentElement;
    root.dataset['storageFailed'] = [...noted].join(' ');
  } catch {
    // No document (a prerender): there is no page to leave the note on.
  }
};

/** Test seam: forget what was noted, so one test's failure is not the next one's silence. */
export const resetStorageNotes = (): void => {
  noted.clear();
  try {
    delete document.documentElement.dataset['storageFailed'];
  } catch {
    // No document.
  }
};

export const browserStorage = (): ClientStorage | null => {
  try {
    return window.localStorage;
  } catch {
    noteStorageFailure('unavailable');
    return null;
  }
};

/** Removes every personal key. Collected first, removed after: removing while counting skips keys. */
export const forgetPersonalData = (storage: ClientStorage | null): void => {
  try {
    if (storage === null) return;
    const found: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && PERSONAL_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        found.push(key);
      }
    }
    for (const key of found) storage.removeItem(key);
  } catch {
    // Storage that cannot be read cannot be leaked from either.
    noteStorageFailure('forget');
  }
};
