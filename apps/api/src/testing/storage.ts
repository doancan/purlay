/**
 * An object store in memory, for the rules that use one (D-109). It keeps what was put and can be
 * told to fail, so a test can show what an upload does when the store refuses it — and what is
 * left behind, which is what `keys()` is for.
 */
import type { ObjectStore, StoredObject } from '../platform/storage';

export interface MemoryStore extends ObjectStore {
  /** Every key held now, sorted. */
  readonly keys: () => string[];
  /** Calls of this kind throw this error, after the first `succeeding` of them have worked. */
  readonly failing: (kind: 'put' | 'delete', error: Error, succeeding?: number) => void;
}

export const aMemoryStore = (): MemoryStore => {
  const objects = new Map<string, Blob>();
  const failures = new Map<'put' | 'delete', { error: Error; succeeding: number }>();
  const failIf = (kind: 'put' | 'delete'): void => {
    const failure = failures.get(kind);
    if (failure === undefined) return;
    if (failure.succeeding > 0) failure.succeeding -= 1;
    else throw failure.error;
  };
  return {
    put: (key, bytes, type): Promise<void> => {
      failIf('put');
      objects.set(key, new Blob([bytes], { type }));
      return Promise.resolve();
    },
    get: (key): Promise<StoredObject | null> => {
      const blob = objects.get(key);
      return Promise.resolve(blob === undefined ? null : { body: blob.stream(), size: blob.size });
    },
    delete: (key): Promise<void> => {
      failIf('delete');
      objects.delete(key);
      return Promise.resolve();
    },
    keys: (): string[] => [...objects.keys()].sort(),
    failing: (kind, error, succeeding = 0): void => {
      failures.set(kind, { error, succeeding });
    },
  };
};
