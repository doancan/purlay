/**
 * `MODULES.md` §11 lists the manifests of the build (D-250): a module nobody wrote down, or one written down that the
 * build does not carry, is a document that disagrees with the code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { bundledModules } from './composition';

const LISTING_HEADING = '## 11. The modules this build carries';
const NONE = '—';

interface Listed {
  readonly id: string;
  readonly requires: readonly string[];
  readonly optional: readonly string[];
  readonly provides: readonly string[];
}

const names = (cell: string): string[] =>
  cell === NONE
    ? []
    : cell
        .split(',')
        .map((name) => name.trim().replaceAll('`', ''))
        .sort();

const listed = (): Listed[] => {
  const text = readFileSync(join(import.meta.dir, '../../../docs/MODULES.md'), 'utf8');
  const start = text.indexOf(LISTING_HEADING);
  if (start === -1) throw new Error(`MODULES.md has no "${LISTING_HEADING}"`);
  return text
    .slice(start + LISTING_HEADING.length)
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => {
      const [id = '', requires = '', optional = '', provides = ''] = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      return {
        id: id.replaceAll('`', ''),
        requires: names(requires),
        optional: names(optional),
        provides: names(provides),
      };
    });
};

describe('MODULES.md lists the manifests of the build', () => {
  test('one row for each module, saying what its manifest says', () => {
    const manifests = bundledModules.map(({ manifest }) => ({
      id: manifest.id,
      requires: [...manifest.requires].sort(),
      optional: [...manifest.optional].sort(),
      provides: [...manifest.provides].sort(),
    }));
    expect(listed()).toEqual(manifests);
  });
});
