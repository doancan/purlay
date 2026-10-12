import { describe, expect, test } from 'bun:test';
import { randomToken, tokenDigest } from './tokens';

describe('bearer tokens', () => {
  test('are 32 random bytes as 64 hex digits, never the same twice', () => {
    const made = new Set(Array.from({ length: 100 }, randomToken));
    expect(made.size).toBe(100);
    for (const token of made) expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  test('are stored as their SHA-256, hex — the published vector for "abc"', async () => {
    expect(await tokenDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
