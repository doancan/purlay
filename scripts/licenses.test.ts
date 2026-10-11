import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkExpression, installedPackages, judgeLicenses } from './licenses';

describe('checkExpression', () => {
  test.each([
    'MIT',
    'ISC',
    'Apache-2.0',
    'BSD-3-Clause',
    'MPL-2.0',
    'BlueOak-1.0.0',
    '(MIT OR Apache-2.0)',
    'MIT AND Zlib',
    'Apache-2.0 WITH LLVM-exception',
    'AGPL-3.0-or-later',
    'GPL-3.0-or-later',
    'LGPL-3.0-only',
    '(GPL-2.0-only OR MIT)',
  ])('%s can ship inside an AGPL-3.0 distribution', (expression) => {
    expect(checkExpression(expression).ok).toBe(true);
  });

  test.each([
    'GPL-2.0-only',
    'GPL-2.0',
    'SSPL-1.0',
    'BUSL-1.1',
    'UNLICENSED',
    'Commons-Clause',
    'CC-BY-NC-4.0',
    'SEE LICENSE IN LICENSE.txt',
    'Some-Invented-License',
    '',
    'MIT AND GPL-2.0-only',
    '(MIT OR',
    'MIT OR OR MIT',
  ])('%j cannot, or cannot be shown to', (expression) => {
    expect(checkExpression(expression).ok).toBe(false);
  });

  test('an OR is satisfied by one allowed side and an AND needs both', () => {
    expect(checkExpression('GPL-2.0-only OR MIT').ok).toBe(true);
    expect(checkExpression('GPL-2.0-only AND MIT').ok).toBe(false);
  });

  test('the reason names the licence that failed', () => {
    expect(checkExpression('MIT AND SSPL-1.0').reason).toContain('SSPL-1.0');
  });
});

describe('installedPackages and judgeLicenses', () => {
  const root = mkdtempSync(join(tmpdir(), 'licenses-'));
  const put = (directory: string, manifest: Record<string, unknown>): void => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
  };

  beforeAll(() => {
    const store = join(root, 'node_modules/.bun');
    put(join(store, 'a@1.0.0/node_modules/a'), { name: 'a', version: '1.0.0', license: 'MIT' });
    put(join(store, '@s+b@2.0.0/node_modules/@s/b'), {
      name: '@s/b',
      version: '2.0.0',
      license: { type: 'ISC' },
    });
    put(join(store, 'c@3.0.0/node_modules/c'), {
      name: 'c',
      version: '3.0.0',
      licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }],
    });
    // a dependency of a, linked beside it: the same package must be counted once
    put(join(store, 'a@1.0.0/node_modules/a/node_modules/inner'), {
      name: 'inner',
      version: '1.0.0',
      license: 'MIT',
    });
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('finds packages, scoped ones, the legacy forms, and reads each once', () => {
    const packages = installedPackages(root);
    expect(packages.map((p) => `${p.name}@${p.version} ${p.license}`).sort()).toEqual([
      '@s/b@2.0.0 ISC',
      'a@1.0.0 MIT',
      'c@3.0.0 (MIT OR Apache-2.0)',
    ]);
    expect(judgeLicenses(packages).ok).toBe(true);
  });

  test('a package with no licence field is a problem, not a pass', () => {
    put(join(root, 'node_modules/.bun/d@1.0.0/node_modules/d'), { name: 'd', version: '1.0.0' });
    const verdict = judgeLicenses(installedPackages(root));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('d@1.0.0');
  });

  test('an incompatible licence names the package that brought it', () => {
    put(join(root, 'node_modules/.bun/e@1.0.0/node_modules/e'), {
      name: 'e',
      version: '1.0.0',
      license: 'SSPL-1.0',
    });
    const verdict = judgeLicenses(installedPackages(root));
    expect(verdict.problems.join('\n')).toContain('e@1.0.0');
    expect(verdict.problems.join('\n')).toContain('SSPL-1.0');
  });

  test('an empty tree is an error rather than a pass', () => {
    mkdirSync(join(root, 'empty/node_modules'), { recursive: true });
    expect(() => installedPackages(join(root, 'empty'))).toThrow(/no installed packages/);
    expect(() => installedPackages(join(root, 'nowhere'))).toThrow(/no installed packages/);
  });
});

describe('the workspace manifests', () => {
  const repo = join(import.meta.dir, '..');
  const manifests = [
    'package.json',
    'apps/api/package.json',
    'apps/web/package.json',
    'packages/config/package.json',
    'packages/db/package.json',
    'packages/markdown/package.json',
    'packages/types/package.json',
  ];
  const notice = readFileSync(join(repo, 'NOTICE'), 'utf8');

  // The grant is NOTICE's: "version 3 ... or (at your option) any later version".
  // LICENSE is the text of the licence and does not choose.
  const expected = /any\s+later\s+version/.test(notice) ? 'AGPL-3.0-or-later' : 'AGPL-3.0-only';

  test('the SPDX identifier is the grant NOTICE makes', () => {
    expect(expected).toBe('AGPL-3.0-or-later');
  });

  test.each(manifests)('%s declares it', (path) => {
    const manifest: unknown = JSON.parse(readFileSync(join(repo, path), 'utf8'));
    expect(manifest).toMatchObject({ license: expected });
  });
});
