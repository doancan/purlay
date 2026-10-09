/**
 * The disclosure path and the review path exist and say what they must (#247).
 *
 * A security policy nobody can find, or a CODEOWNERS whose syntax GitHub quietly
 * ignores, looks like a control and is not one.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');
const read = (path: string): string => readFileSync(join(repo, path), 'utf8');

/** The rules in a CODEOWNERS file: a pattern and the owners after it. */
const rules = (text: string): { pattern: string; owners: string[] }[] =>
  text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [pattern = '', ...owners] = line.split(/\s+/);
      return { pattern, owners };
    });

describe('SECURITY.md', () => {
  const text = read('SECURITY.md');

  test('names the private channel, the supported versions and the response targets', () => {
    expect(text).toContain('/security/advisories/new');
    expect(text).toMatch(/## Supported versions/);
    expect(text).toMatch(/## Reporting a vulnerability/);
    expect(text).toMatch(/within 5 working days/);
    expect(text).toMatch(/Do not open a public issue/);
  });
});

describe('CODEOWNERS', () => {
  const parsed = rules(read('.github/CODEOWNERS'));

  test('has rules, each with a pattern and at least one owner GitHub can resolve', () => {
    expect(parsed.length).toBeGreaterThan(0);
    for (const { pattern, owners } of parsed) {
      expect(owners.length).toBeGreaterThan(0);
      for (const owner of owners) expect(owner).toMatch(/^@[\w-]+(\/[\w-]+)?$|^[^@\s]+@[^@\s]+$/);
      expect(pattern).not.toMatch(/\[|\]|!/); // CODEOWNERS has no character classes or negation
    }
  });

  test('a catch-all rule means no file is without a reviewer', () => {
    expect(parsed.some(({ pattern }) => pattern === '*')).toBe(true);
  });

  test('the workflows and the scripts have their own rules', () => {
    const patterns = parsed.map(({ pattern }) => pattern);
    expect(patterns).toContain('/.github/');
    expect(patterns).toContain('/scripts/');
  });

  test('the reader rejects a malformed rule', () => {
    expect(rules('/path\n')).toEqual([{ pattern: '/path', owners: [] }]);
    expect(rules('# only a comment\n\n')).toEqual([]);
  });
});
