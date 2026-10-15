/**
 * Where unsent text is kept, and that no storage failure reaches the person.
 */
import { describe, expect, test } from 'bun:test';
import { draftKey, readDraft, writeDraft, type DraftStorage } from './drafts';

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
