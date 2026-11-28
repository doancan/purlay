import { describe, expect, test } from 'bun:test';
import { prefetch } from './prefetch';

describe('reading ahead', () => {
  test('starts the load at once, and a failed one is let go rather than left unhandled', async () => {
    let asked = 0;
    prefetch(() => {
      asked += 1;
      return Promise.reject(new Error('offline'));
    });
    expect(asked).toBe(1);
    // A rejection nobody handled would fail the process on the next turn; reaching here is the proof.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
