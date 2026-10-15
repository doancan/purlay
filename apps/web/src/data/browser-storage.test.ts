/**
 * What the page keeps in the browser: which of it is a person's, what happens when the
 * browser refuses, and the one note that says so.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readDraft, writeDraft } from '../features/composer/drafts';
import { lastChannel, rememberChannel } from '../features/questions/last-channel';
import { loadStored, pendingKey, saveStored } from '../realtime/pending-store';
import { installDom } from '../testing/dom';
import { memoryStorage } from '../testing/fakes';
import {
  browserStorage,
  claimFor,
  forgetPersonalData,
  isClaimedBy,
  PERSON_KEY,
  noteStorageFailure,
  resetStorageNotes,
  type ClientStorage,
} from './browser-storage';
import { PUSH_OWNER_KEY } from '../features/push/push';

installDom();
afterEach(resetStorageNotes);

const refusing = (): ClientStorage => ({
  getItem: (): string | null => {
    throw new Error('blocked');
  },
  setItem: (): void => {
    throw new Error('quota');
  },
  removeItem: (): void => {
    throw new Error('blocked');
  },
  key: (): string | null => {
    throw new Error('blocked');
  },
  get length(): number {
    throw new Error('blocked');
  },
});

const note = (): string | undefined => document.documentElement.dataset['storageFailed'];

describe('forgetting a person', () => {
  test('removes drafts, the last channel, unsent messages and whose push this browser’s is — every one, not every other one — and nothing of the device', () => {
    const storage = memoryStorage({
      'purlay.draft.a': '1',
      'purlay.draft.a.b': '2',
      'purlay.draft.c': '3',
      'purlay.lastChannel.w': 'c',
      'purlay.pending.u': '[]',
      // The next person to sign in here finds push off, not the last person's notices (D-126).
      [PUSH_OWNER_KEY]: 'u1',
      'purlay.theme': 'dark',
      'purlay.locale': 'tr',
    });
    forgetPersonalData(storage);
    expect(Object.keys(storage.data).sort()).toEqual(['purlay.locale', 'purlay.theme']);
  });

  // A session can end without this page signing out — elsewhere, by expiry, by revocation — and
  // then the next person to sign in here would find the last one's drafts (#694).
  test('a different person claiming the page forgets the last one first; the same person keeps theirs', () => {
    const storage = memoryStorage({
      [PERSON_KEY]: 'bob',
      'purlay.draft.c': "bob's words",
      'purlay.lastChannel.w': 'c',
      'purlay.theme': 'dark',
    });
    claimFor(storage, 'bob');
    expect(storage.data['purlay.draft.c']).toBe("bob's words");

    claimFor(storage, 'alice');
    expect(storage.data).toEqual({ [PERSON_KEY]: 'alice', 'purlay.theme': 'dark' });
  });

  test('a page nobody is recorded on hands nothing over: what it holds is forgotten first', () => {
    // A page from before the record, or one a sign-out forgot: what is there cannot be vouched for.
    const storage = memoryStorage({ 'purlay.draft.u0.c': 'words', 'purlay.theme': 'dark' });
    claimFor(storage, 'alice');
    expect(storage.data).toEqual({ [PERSON_KEY]: 'alice', 'purlay.theme': 'dark' });
  });

  test('signing out forgets whose the page was, so nothing written after it is kept', () => {
    const storage = memoryStorage({ [PERSON_KEY]: 'alice', 'purlay.draft.alice.c': 'words' });
    forgetPersonalData(storage);
    expect(storage.data).toEqual({});
    expect(isClaimedBy(storage, 'alice')).toBe(false);
  });

  test('a forget that does not finish leaves the record as it was, and the next claim tries again', () => {
    const data = new Map<string, string>([
      [PERSON_KEY, 'bob'],
      ['purlay.draft.bob.c', "bob's"],
    ]);
    let refuse = true;
    const storage: ClientStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value): void => {
        data.set(key, value);
      },
      removeItem: (key): void => {
        if (refuse) throw new Error('blocked');
        data.delete(key);
      },
      key: (index) => [...data.keys()][index] ?? null,
      get length(): number {
        return data.size;
      },
    };
    claimFor(storage, 'alice');
    expect(data.get(PERSON_KEY)).toBe('bob');
    expect(isClaimedBy(storage, 'alice')).toBe(false);
    refuse = false;
    claimFor(storage, 'alice');
    expect(Object.fromEntries(data)).toEqual({ [PERSON_KEY]: 'alice' });
  });

  test('a claim on storage that refuses does not throw, and leaves a note', () => {
    expect(() => {
      claimFor(refusing(), 'alice');
    }).not.toThrow();
    expect(note()).toContain('claim');
  });

  test('is not stopped by storage that refuses, and leaves a note', () => {
    forgetPersonalData(refusing());
    forgetPersonalData(null);
    expect(note()).toBe('forget');
  });
});

describe("the browser's storage", () => {
  test("is the page's, or none and a note when reading the property itself throws", () => {
    expect(browserStorage()).toBe(window.localStorage);
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: (): never => {
        throw new Error('blocked');
      },
    });
    try {
      expect(browserStorage()).toBeNull();
      expect(note()).toBe('unavailable');
    } finally {
      if (original !== undefined) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('the note that storage failed', () => {
  test('is left once per kind of failure, and lists them all', () => {
    noteStorageFailure('draft-write');
    noteStorageFailure('draft-write');
    noteStorageFailure('pending-read');
    expect(note()).toBe('draft-write pending-read');
  });

  test('is left by each place that keeps something, and none of them throws', () => {
    expect(readDraft(refusing(), 'k')).toBe('');
    writeDraft(refusing(), 'k', 'text');
    expect(loadStored(refusing(), 'u')).toEqual([]);
    saveStored(refusing(), 'u', []);
    expect(note()).toBe('draft-read draft-write pending-read pending-write');
  });

  test('the last channel is read and written through the page, and its failures are noted', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', { configurable: true, get: refusing });
    try {
      rememberChannel('w', 'c');
      expect(lastChannel('w')).toBeNull();
      expect(note()).toBe('last-channel-write last-channel-read');
    } finally {
      if (original !== undefined) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('unsent messages in storage', () => {
  const stored = {
    id: '01a12088-d200-7348-8241-dfbba0e7cffa',
    channelId: '00000000-0000-4000-8000-0000000000c1',
    parentId: null,
    content: 'hello',
    createdAt: '2026-10-09T12:00:00.000Z',
  };

  test('only what this wrote is read back: junk, other shapes and empty text are ignored', () => {
    const storage = memoryStorage({
      [pendingKey('u')]: JSON.stringify([
        stored,
        { ...stored, id: 'not-an-id' },
        { ...stored, content: '' },
        { ...stored, parentId: 5 },
        'a string',
        null,
      ]),
    });
    expect(loadStored(storage, 'u')).toEqual([stored]);
    storage.setItem(pendingKey('v'), '{"not":"a list"}');
    expect(loadStored(storage, 'v')).toEqual([]);
    storage.setItem(pendingKey('w'), '{broken');
    expect(loadStored(storage, 'w')).toEqual([]);
    expect(note()).toBe('pending-read');
  });

  test('the character budget keeps the newest and drops the oldest', () => {
    const storage = memoryStorage();
    const big = 'x'.repeat(120_000);
    saveStored(storage, 'u', [
      { ...stored, id: '01a12088-d200-7348-8241-dfbba0e7cf01', content: big },
      { ...stored, id: '01a12088-d200-7348-8241-dfbba0e7cf02', content: big },
    ]);
    const kept = loadStored(storage, 'u');
    expect(kept.map((m) => m.id)).toEqual(['01a12088-d200-7348-8241-dfbba0e7cf02']);
  });

  test('an empty list removes the entry', () => {
    const storage = memoryStorage({ [pendingKey('u')]: '[]' });
    saveStored(storage, 'u', []);
    expect(storage.data[pendingKey('u')]).toBeUndefined();
  });
});
