import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { featureFences, featureIds, type FeatureFence } from './feature-fences.mjs';

const optionsOf = (
  fence: FeatureFence | undefined,
): FeatureFence['rules']['no-restricted-imports'][1] => {
  if (fence === undefined) throw new Error('no fence was made');
  return fence.rules['no-restricted-imports'][1];
};

describe('the folders that are modules', () => {
  test('are the directories, by name, and a file is not one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'features-'));
    mkdirSync(join(dir, 'notes'));
    mkdirSync(join(dir, 'issues'));
    writeFileSync(join(dir, 'README.md'), '');
    expect(featureIds(dir)).toEqual(['issues', 'notes']);
  });

  test('are none when the folder is not there', () => {
    expect(featureIds(join(tmpdir(), 'no-such-features-folder'))).toEqual([]);
  });
});

describe('the fence of a feature', () => {
  const transport = { group: ['elysia'], message: 't' };
  const database = { name: '@purlay/db', message: 'd' };

  test('names every other feature, as a path inside and as a folder above', () => {
    const [issues] = featureFences(
      'apps/api/src/features',
      ['issues', 'notes', 'mail'],
      transport,
      () => [database],
    );
    expect(issues?.files).toEqual(['apps/api/src/features/issues/**/*.ts']);
    const options = optionsOf(issues);
    const rule = options.patterns[1];
    const regex = new RegExp(rule?.regex ?? '(?!)');
    expect(regex.test('../notes/service')).toBe(true);
    expect(regex.test('@/features/mail/x')).toBe(true);
    expect(regex.test('../issues/service')).toBe(false);
    expect(rule?.message).toContain('notes, mail');
    expect(options.paths).toEqual([database]);
  });

  test('a lone feature has no one to be kept from', () => {
    const [only] = featureFences('d', ['chat'], transport, () => [database]);
    expect(optionsOf(only).patterns).toEqual([transport]);
  });

  test('may give one feature other paths than the rest', () => {
    const exempt = { name: 'x', message: 'x' };
    const fences = featureFences('d', ['chat', 'notes'], transport, (id) =>
      id === 'chat' ? [database] : [database, exempt],
    );
    expect(optionsOf(fences[0]).paths).toEqual([database]);
    expect(optionsOf(fences[1]).paths).toEqual([database, exempt]);
  });

  test('may give the tests of a feature paths of their own, in a block after the feature’s', () => {
    const wholeDatabase = { name: '@purlay/db', message: 'w' };
    const fences = featureFences(
      'd',
      ['chat', 'notes'],
      transport,
      (id) => [database, ...(id === 'notes' ? [wholeDatabase] : [])],
      () => [database],
    );
    expect(fences.map((fence) => fence.files)).toEqual([
      ['d/chat/**/*.ts'],
      ['d/chat/**/*.test.ts'],
      ['d/notes/**/*.ts'],
      ['d/notes/**/*.test.ts'],
    ]);
    expect(optionsOf(fences[2]).paths).toEqual([database, wholeDatabase]);
    expect(optionsOf(fences[3]).paths).toEqual([database]);
    expect(optionsOf(fences[3]).patterns).toEqual(optionsOf(fences[2]).patterns);
  });

  test('may give a feature’s http folder the transport types the rest of it is kept from, in blocks after the feature’s', () => {
    const realtime = { group: ['**/realtime/**'], message: 'r' };
    const fences = featureFences(
      'd',
      ['chat', 'notes'],
      transport,
      () => [database],
      () => [database],
      realtime,
    );
    expect(fences.map((fence) => fence.files)).toEqual([
      ['d/chat/**/*.ts'],
      ['d/chat/**/*.test.ts'],
      ['d/chat/http/**/*.ts'],
      ['d/chat/http/**/*.test.ts'],
      ['d/notes/**/*.ts'],
      ['d/notes/**/*.test.ts'],
      ['d/notes/http/**/*.ts'],
      ['d/notes/http/**/*.test.ts'],
    ]);
    expect(optionsOf(fences[0]).patterns[0]).toEqual(transport);
    expect(optionsOf(fences[2]).patterns[0]).toEqual(realtime);
    // Still kept from every other feature, and from its tables.
    expect(optionsOf(fences[2]).patterns[1]?.message).toContain('notes');
    expect(optionsOf(fences[2]).paths).toEqual([database]);
    // Its tests stand the application up, and are kept from no transport, only from the others' features.
    expect(optionsOf(fences[3]).paths).toEqual([]);
    expect(optionsOf(fences[3]).patterns).toHaveLength(1);
    expect(optionsOf(fences[3]).patterns[0]?.message).toContain('notes');
  });

  test('may keep a feature’s code from the composition, its tests and its http folder aside', () => {
    const realtime = { group: ['**/realtime/**'], message: 'r' };
    const composition = { group: ['**/composition'], message: 'c' };
    const fences = featureFences(
      'd',
      ['chat', 'notes'],
      transport,
      () => [database],
      () => [database],
      realtime,
      composition,
    );
    // The feature's code (its first block) is kept from it, after the transport; the blocks that win for the rest are not.
    expect(optionsOf(fences[0]).patterns.slice(0, 2)).toEqual([transport, composition]);
    expect(optionsOf(fences[4]).patterns.slice(0, 2)).toEqual([transport, composition]);
    for (const winning of [1, 2, 3, 5, 6, 7]) {
      expect(optionsOf(fences[winning]).patterns).not.toContain(composition);
    }
  });

  test('keeps every file of a feature from the ways round the fences, the http folder and the tests included', () => {
    const realtime = { group: ['**/realtime/**'], message: 'r' };
    const bypass = { group: ['**/packages/**'], message: 'b' };
    const fences = featureFences(
      'd',
      ['chat', 'notes'],
      transport,
      () => [database],
      () => [database],
      realtime,
      undefined,
      [bypass],
    );
    expect(fences).toHaveLength(8);
    for (const fence of fences) expect(optionsOf(fence).patterns).toContain(bypass);
  });

  test('keeps a feature from nothing more when it is given no composition to keep it from', () => {
    const [only] = featureFences('d', ['chat'], transport, () => [database]);
    expect(optionsOf(only).patterns).toEqual([transport]);
  });
});
