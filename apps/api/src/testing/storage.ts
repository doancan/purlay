/**
 * An object store in memory, for the rules that use one (D-109). It keeps what was put and can be
 * told to fail, so a test can show what an upload does when the store refuses it — and what is
 * left behind, which is what `keys()` is for.
 */
import type { ObjectStore } from '../platform/storage';

export interface MemoryStore extends ObjectStore {
  /** Every key held now, sorted. */
  readonly keys: () => string[];
  /** The next calls of this kind throw this error. */
  readonly failing: (kind: 'put' | 'delete', error: Error) => void;
}

export const aMemoryStore = (): MemoryStore => {
  const objects = new Map<string, Blob>();
  const failures = new Map<'put' | 'delete', Error>();
  const failIf = (kind: 'put' | 'delete'): void => {
    const failure = failures.get(kind);
    if (failure !== undefined) throw failure;
  };
  return {
    put: (key, bytes, type): Promise<void> => {
      failIf('put');
      objects.set(key, new Blob([bytes], { type }));
      return Promise.resolve();
    },
    get: (key): Promise<Blob | null> => Promise.resolve(objects.get(key) ?? null),
    delete: (key): Promise<void> => {
      failIf('delete');
      objects.delete(key);
      return Promise.resolve();
    },
    keys: (): string[] => [...objects.keys()].sort(),
    failing: (kind, error): void => {
      failures.set(kind, error);
    },
  };
};
