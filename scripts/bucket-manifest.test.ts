import { describe, expect, test } from 'bun:test';
import {
  differences,
  objectPath,
  parseManifest,
  sha256Hex,
  sortedManifest,
} from './bucket-manifest';

const entry = (key: string, content: string): { key: string; size: number; sha256: string } => ({
  key,
  size: content.length,
  sha256: sha256Hex(new TextEncoder().encode(content)),
});

describe('objectPath', () => {
  test('keeps an ordinary key, slashes included, under the root', () => {
    expect(objectPath('/backup/objects', 'a/b/c.bin')).toBe('/backup/objects/a/b/c.bin');
  });

  test.each([
    '../escape',
    'a/../../escape',
    '/etc/passwd',
    '',
    'a\0b',
    '..',
    'a//b',
    'a/./b',
    'dir/',
  ])('refuses %j', (key) => {
    expect(() => objectPath('/backup/objects', key)).toThrow(/refusing/);
  });

  test('a sibling directory that shares a prefix is not inside the root', () => {
    expect(() => objectPath('/backup/objects', '../objects-evil/x')).toThrow(/refusing/);
  });
});

describe('sha256Hex', () => {
  test('is the standard digest', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('manifests', () => {
  test('are sorted by key so equal contents are equal text', () => {
    const a = sortedManifest([entry('b', '2'), entry('a', '1')]);
    expect(a.map((e) => e.key)).toEqual(['a', 'b']);
  });

  test('round-trip through text, and a malformed one is refused', () => {
    const manifest = sortedManifest([entry('a', '1')]);
    expect(parseManifest(JSON.stringify(manifest))).toEqual(manifest);
    expect(() => parseManifest('{}')).toThrow(/array/);
    expect(() => parseManifest('[1]')).toThrow(/not an object/);
    expect(() => parseManifest('[{"key":"a","size":-1,"sha256":"x"}]')).toThrow(/malformed/);
    expect(() => parseManifest('[{"key":"a","size":1,"sha256":"zz"}]')).toThrow(/malformed/);
  });
});

describe('differences', () => {
  const base = [entry('a', '1'), entry('b', '22')];

  test('identical manifests differ in nothing', () => {
    expect(differences(base, [...base])).toEqual([]);
  });

  test('a missing, an unexpected, a resized and a corrupted object are each named', () => {
    expect(differences(base, [entry('a', '1')])).toEqual(['missing: b']);
    expect(differences(base, [...base, entry('c', '3')])).toEqual(['unexpected: c']);
    expect(differences(base, [entry('a', '1'), entry('b', '2')])).toEqual([
      'size differs: b (2 -> 1)',
    ]);
    // same size, different bytes: only the checksum can see it
    expect(differences(base, [entry('a', '1'), entry('b', '23')])).toEqual(['content differs: b']);
  });
});
