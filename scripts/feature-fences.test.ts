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
});
