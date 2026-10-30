/**
 * Where unsent text is kept, and that no storage failure reaches the person.
 */
import { describe, expect, test } from 'bun:test';
import { draftKey, listDrafts, readDraft, writeDraft, type DraftStorage } from './drafts';

const memory = (): DraftStorage & { readonly items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key): string | null => items.get(key) ?? null,
    setItem: (key, value): void => {
      items.set(key, value);
    },
    removeItem: (key): void => {
      items.delete(key);
    },
    key: (index): string | null => [...items.keys()][index] ?? null,
    get length(): number {
      return items.size;
    },
  };
};

const broken: DraftStorage = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('full');
  },
  removeItem: () => {
    throw new Error('blocked');
  },
  length: 0,
  key: () => {
    throw new Error('blocked');
  },
};

describe('where a draft lives', () => {
  test('a channel and a thread in it never share one', () => {
    expect(draftKey('u1', 'c1', undefined)).toBe('purlay.draft.u1.c1');
    expect(draftKey('u1', 'c1', 'm1')).toBe('purlay.draft.u1.c1.m1');
    expect(draftKey('u1', 'c1', 'm1')).not.toBe(draftKey('u1', 'c1', 'm2'));
    expect(draftKey('u1', 'c1', undefined)).not.toBe(draftKey('u1', 'c2', undefined));
    // Nor do two people (#694).
    expect(draftKey('u1', 'c1', undefined)).not.toBe(draftKey('u2', 'c1', undefined));
  });
});

describe('remembering', () => {
  test('writes, reads back, and forgets when the text is empty', () => {
    const storage = memory();
    writeDraft(storage, 'k', 'half a thought');
    expect(readDraft(storage, 'k')).toBe('half a thought');
    writeDraft(storage, 'k', '');
    expect(storage.items.has('k')).toBe(false);
    expect(readDraft(storage, 'k')).toBe('');
  });

  test('a page with no storage remembers nothing and breaks nothing', () => {
    writeDraft(null, 'k', 'text');
    expect(readDraft(null, 'k')).toBe('');
  });

  test('storage that throws is a draft not remembered', () => {
    expect(readDraft(broken, 'k')).toBe('');
    writeDraft(broken, 'k', 'text');
    writeDraft(broken, 'k', '');
  });
});

describe('listing drafts (D-215)', () => {
  test('lists this person’s drafts — a channel’s and a thread’s — and nobody else’s or empty ones', () => {
    const storage = memory();
    writeDraft(storage, draftKey('me', 'c1', undefined), 'half a thought');
    writeDraft(storage, draftKey('me', 'c2', 'root9'), 'a reply');
    writeDraft(storage, draftKey('someone-else', 'c1', undefined), 'not mine');
    storage.setItem(draftKey('me', 'c3', undefined), '   ');
    storage.setItem('purlay.theme', 'dark');
    expect(listDrafts(storage, 'me')).toEqual([
      {
        key: draftKey('me', 'c1', undefined),
        channelId: 'c1',
        parentId: null,
        text: 'half a thought',
      },
      { key: draftKey('me', 'c2', 'root9'), channelId: 'c2', parentId: 'root9', text: 'a reply' },
    ]);
  });

  test('a storage that refuses, or none, is no drafts, never an error', () => {
    expect(listDrafts(broken, 'me')).toEqual([]);
    expect(listDrafts(null, 'me')).toEqual([]);
  });
});
