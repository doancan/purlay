import { describe, expect, test } from 'bun:test';
import { digestsEqual, randomSymbols, randomToken, tokenDigest } from './tokens';

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

describe('random symbols, for a secret a person types', () => {
  test('are drawn from the alphabet only, and every symbol of it turns up', () => {
    const drawn = Array.from({ length: 200 }, () => randomSymbols('ABCD', 20)).join('');
    expect(drawn).toMatch(/^[ABCD]+$/);
    expect(new Set(drawn).size).toBe(4);
  });

  test('refuse an alphabet one byte cannot pick from evenly', () => {
    expect(() => randomSymbols('ABC', 4)).toThrow('divides 256');
    expect(() => randomSymbols('', 4)).toThrow('divides 256');
  });
});

describe('digests compared in constant time', () => {
  test('equal only when every character is', async () => {
    const digest = await tokenDigest('a');
    expect(digestsEqual(digest, digest)).toBe(true);
    expect(digestsEqual(digest, await tokenDigest('b'))).toBe(false);
    expect(digestsEqual(digest, `${digest.slice(0, -1)}0`)).toBe(digest.endsWith('0'));
  });

  test('a different length is unequal, not an error', () => {
    expect(digestsEqual('abc', 'abcd')).toBe(false);
    expect(digestsEqual('', '')).toBe(true);
  });
});
