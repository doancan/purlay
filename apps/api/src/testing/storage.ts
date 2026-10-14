/**
 * An object store in memory, for the rules that use one (D-109). It keeps what was put and can be
 * told to fail, so a test can show what an upload does when the store refuses it — and what is
 * left behind, which is what `keys()` is for.
 */
import type { ObjectStore, StoredObject } from '../platform/storage';

export interface MemoryStore extends ObjectStore {
  /** Every key held now, sorted. */
  readonly keys: () => string[];
  /**
   * Calls of this kind throw this error, after the first `succeeding` of them have worked. `stream`
   * fails a read halfway: the object is found, and its body errors after its first byte.
   */
  readonly failing: (
    kind: 'put' | 'delete' | 'get' | 'stream',
    error: Error,
    succeeding?: number,
  ) => void;
}

export const aMemoryStore = (): MemoryStore => {
  const objects = new Map<string, Blob>();
  type Kind = 'put' | 'delete' | 'get' | 'stream';
  const failures = new Map<Kind, { error: Error; succeeding: number }>();
  const failIf = (kind: Kind): void => {
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
    putFile: async (key, path, type): Promise<void> => {
      failIf('put');
      const file = Bun.file(path);
      objects.set(key, new Blob([await file.arrayBuffer()], { type }));
    },
    get: (key): Promise<StoredObject | null> => {
      failIf('get');
      const blob = objects.get(key);
      if (blob === undefined) return Promise.resolve(null);
      let broken: Error | null = null;
      try {
        failIf('stream');
      } catch (error) {
        broken = error as Error;
      }
      if (broken === null) return Promise.resolve({ body: blob.stream(), size: blob.size });
      const failure = broken;
      // A body that gives its first byte, then fails: a connection lost mid-read.
      const body = new ReadableStream<Uint8Array>({
        start: async (controller): Promise<void> => {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          controller.enqueue(bytes.slice(0, 1));
          controller.error(failure);
        },
      });
      return Promise.resolve({ body, size: blob.size });
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
