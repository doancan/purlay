import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { assembleBundle } from '../contract/bundle';
import { bundleProblems, main, writeBundle } from './contract-bundle';

const made: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  made.push(dir);
  return join(dir, 'out');
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const bundle = assembleBundle('.');

describe('writing the bundle and checking a directory against it', () => {
  test('what was written is the bundle, byte for byte', () => {
    const out = scratch();
    writeBundle(bundle, out);
    expect(bundleProblems(bundle, out)).toEqual([]);
    expect(readFileSync(join(out, 'MANIFEST.json'), 'utf8')).toBe(
      bundle.get('MANIFEST.json') ?? '',
    );
  });

  test('writing again replaces what was there: a file the bundle no longer has does not linger', () => {
    const out = scratch();
    writeBundle(bundle, out);
    writeFileSync(join(out, 'stale.json'), '{}');
    writeBundle(bundle, out);
    expect(bundleProblems(bundle, out)).toEqual([]);
  });

  test('a changed file, a missing file and an extra file are each named', () => {
    const out = scratch();
    writeBundle(bundle, out);
    writeFileSync(join(out, 'contract.json'), '{}');
    rmSync(join(out, 'README.md'));
    writeFileSync(join(out, 'fixtures', 'extra.json'), '{}');
    expect(bundleProblems(bundle, out).slice().sort()).toEqual([
      'differs: contract.json',
      'missing: README.md',
      'unexpected: fixtures/extra.json',
    ]);
  });

  test('refuses to replace a directory that is not a bundle: --out . must not empty what it names', () => {
    const out = scratch();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'precious.txt'), 'mine');
    expect(() => {
      writeBundle(bundle, out);
    }).toThrow('is not empty and is not a bundle');
    expect(readFileSync(join(out, 'precious.txt'), 'utf8')).toBe('mine');
  });

  test('replaces an empty directory, and a directory that holds a bundle', () => {
    const out = scratch();
    mkdirSync(out, { recursive: true });
    writeBundle(bundle, out);
    writeBundle(bundle, out);
    expect(bundleProblems(bundle, out)).toEqual([]);
    expect(existsSync(join(out, 'MANIFEST.json'))).toBe(true);
  });

  test('a directory that is not there is a problem, not a pass', () => {
    const missing = join(scratch(), 'nowhere');
    expect(bundleProblems(bundle, missing)).toEqual([`${missing} cannot be read: ENOENT`]);
  });
});

describe('the command', () => {
  const quietly = <T>(work: () => T): T => {
    const { log, error } = console;
    console.log = (): void => undefined;
    console.error = (): void => undefined;
    try {
      return work();
    } finally {
      console.log = log;
      console.error = error;
    }
  };

  test('writes with --out and then passes its own --check', () => {
    const out = scratch();
    expect(quietly(() => main(['--out', out], bundle))).toBe(0);
    expect(quietly(() => main(['--check', out], bundle))).toBe(0);
  });

  test('fails --check on a directory that is not the bundle', () => {
    const out = scratch();
    quietly(() => main(['--out', out], bundle));
    writeFileSync(join(out, 'contract.json'), '{}');
    expect(quietly(() => main(['--check', out], bundle))).toBe(1);
  });

  test('says why and fails, rather than throwing, when --out would empty something else', () => {
    const out = scratch();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'precious.txt'), 'mine');
    expect(quietly(() => main(['--out', out], bundle))).toBe(1);
    expect(readFileSync(join(out, 'precious.txt'), 'utf8')).toBe('mine');
  });

  test('is a usage error without a directory, in either mode', () => {
    expect(quietly(() => main([], bundle))).toBe(2);
    expect(quietly(() => main(['--out'], bundle))).toBe(2);
    expect(quietly(() => main(['--check'], bundle))).toBe(2);
  });
});
