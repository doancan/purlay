/** The door to a chunk (`chunk.ts`): shared while it works, forgotten when it fails. */
import { describe, expect, test } from 'bun:test';
import { chunkOf } from './chunk';

describe('a chunk’s door', () => {
  test('a request that fails is forgotten, so the next ask tries again; one that succeeds is shared', async () => {
    let calls = 0;
    const chunk = chunkOf(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('screens');
    });
    const failure = await chunk.get().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('offline');
    expect(await chunk.get()).toBe('screens');
    expect(await chunk.get()).toBe('screens');
    expect(calls).toBe(2);
  });

  test('warming never throws, even when the request fails, and the failure is not kept', async () => {
    let calls = 0;
    const chunk = chunkOf(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('screens');
    });
    chunk.warm();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await chunk.get()).toBe('screens');
  });
});
