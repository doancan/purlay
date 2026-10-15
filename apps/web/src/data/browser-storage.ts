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
 * *device's*, stay. A session can also end without this page signing out — on another
 * device, by expiry, by revocation — so the page records whose the keys are, and a
 * different person signing in here forgets them first (`claimFor`, #694).
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

/**
 * The keys that hold what a person wrote, where they were, or that push here is theirs (D-126).
 * Anything else on the page is the device's.
 */
const PERSONAL_PREFIXES = [
  'purlay.person',
  'purlay.draft.',
  'purlay.lastChannel.',
  'purlay.pending.',
  'purlay.push.',
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

/** Whose the personal keys on this page are: the person who holds a session here now (#694). */
export const PERSON_KEY = 'purlay.person';

/**
 * Says whose the page's personal keys are, the moment the page learns who is signed in and before
 * anything reads a draft (#694). Anybody but the person recorded — someone else, or nobody known,
 * as on a page from before the record existed — means what is kept may not be theirs, and it is
 * forgotten first: the last session may have ended without this page signing out (elsewhere, by
 * expiry, by revocation). The same person keeps everything. It fails closed: a forget that did not
 * finish leaves the record as it was, so the next claim tries again rather than handing over what
 * is left.
 */
/**
 * Whether the page is still this person's: what they write is kept only while it is. A sign-out
 * forgets the record, and another person signing in elsewhere in the browser replaces it, so a
 * composer's last write after either — its timer, or its flush as the screen goes — keeps nothing.
 */
export const isClaimedBy = (
  storage: Pick<ClientStorage, 'getItem'> | null,
  userId: string,
): boolean => {
  try {
    return storage?.getItem(PERSON_KEY) === userId;
  } catch {
    return false;
  }
};

export const claimFor = (storage: ClientStorage | null, userId: string): void => {
  try {
    if (storage === null) return;
    if (storage.getItem(PERSON_KEY) === userId) return;
    if (!forgetPersonalData(storage)) return;
    storage.setItem(PERSON_KEY, userId);
  } catch {
    // Unreadable storage cannot be read from either; a record that cannot be written is tried again.
    noteStorageFailure('claim');
  }
};

/**
 * Removes every personal key, and says whether it finished. Collected first, removed after:
 * removing while counting skips keys.
 */
export const forgetPersonalData = (storage: ClientStorage | null): boolean => {
  try {
    if (storage === null) return true;
    const found: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && PERSONAL_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        found.push(key);
      }
    }
    for (const key of found) storage.removeItem(key);
    return true;
  } catch {
    // Storage that cannot be read cannot be leaked from either.
    noteStorageFailure('forget');
    return false;
  }
};
