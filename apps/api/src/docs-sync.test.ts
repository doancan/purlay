/**
 * The tables the documents get from the code (`testing/docs-sync.ts`) are what the code makes of them.
 *
 * A table someone edited by hand, or one the code outgrew, is a number in two places again; this is the check that
 * says so, with the command that mends it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { staleFiles } from './testing/docs-sync';

describe('generated blocks', () => {
  test('every document is what the code makes of it (bun run docs:sync)', () => {
    expect(staleFiles()).toEqual([]);
  });

  test('a hand edit inside a block is stale', () => {
    const edited = (file: string): string => {
      const text = readFileSync(file, 'utf8');
      return file === 'docs/MODULES.md'
        ? text.replace('| `issues` | 8 s |', '| `issues` | 9 s |')
        : text;
    };
    expect(edited('docs/MODULES.md')).not.toBe(readFileSync('docs/MODULES.md', 'utf8'));
    expect(staleFiles(edited)).toEqual(['docs/MODULES.md']);
  });

  test('a document that lost its markers is refused, not skipped', () => {
    expect(() => staleFiles(() => 'no markers here')).toThrow('markers');
  });
});
