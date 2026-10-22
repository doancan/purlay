/**
 * What the setup code is, without a database (D-179 §4.1): the integration tests read it from the log;
 * these hold its shape and the one place it may be written.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEVER_LOGGED } from '../../platform/logging';
import { SETUP_CODE_LINE } from './setup';

describe('the setup code’s line in the log', () => {
  test('is a constant an operator can search for', () => {
    expect(SETUP_CODE_LINE).toContain('SETUP CODE');
  });

  test('carries the code under a field the logger lets through, and the claim’s token under one it never does', () => {
    expect(NEVER_LOGGED.has('setupCode')).toBe(false);
    expect(NEVER_LOGGED.has('claimToken')).toBe(true);
  });
});

describe('a presented secret against the stored digest', () => {
  const source = readFileSync(join(import.meta.dir, 'setup.ts'), 'utf8');

  test('is compared only by `digestsEqual`, in constant time — never by `===`, which stops at the first difference', () => {
    // A digest on either side of an equality, other than a check for `null`.
    const digest = String.raw`(?:presented|claimDigest|\w+\.\w*_digest|\w+\.claimDigest)`;
    expect(source).not.toMatch(new RegExp(String.raw`${digest}\s*[!=]==(?!\s*null\b)`));
    expect(source).not.toMatch(new RegExp(String.raw`[!=]==\s*${digest}`));
    expect(source.match(/digestsEqual\(/g)).toHaveLength(3);
  });
});
