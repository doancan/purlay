/**
 * `MODULES.md` §11 lists the manifests of the build (D-250): a module nobody wrote down, or one written down that the
 * build does not carry, is a document that disagrees with the code. Each module also has a section there that says when
 * it would be removed (D-250 rule 6), which may be `none, because …` and may not be left out.
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

const modulesDocument = (): string =>
  readFileSync(join(import.meta.dir, '../../../docs/MODULES.md'), 'utf8');

const listed = (): Listed[] => {
  const text = modulesDocument();
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

/** The sections of §11 by module id, each as its text up to the next heading. */
const sections = (): Map<string, string> => {
  const text = modulesDocument();
  const start = text.indexOf(LISTING_HEADING);
  const end = text.indexOf('\n## ', start + LISTING_HEADING.length);
  const listing = text.slice(start, end === -1 ? undefined : end);
  return new Map(
    listing
      .split(/^### /m)
      .slice(1)
      .map((section) => {
        const [heading = '', ...body] = section.split('\n');
        return [heading.replaceAll('`', '').trim(), body.join('\n')];
      }),
  );
};

/** What a section says after `Removal threshold.`, up to the end of its paragraph or item. */
const REMOVAL_THRESHOLD = /\*\*Removal threshold\.\*\*\s+(\S[^]*?)(?:\n\s*\n|\n- \*\*|$)/;

describe('MODULES.md §11 has a section for each module, with its removal threshold', () => {
  test('a section for each module of the build and for no other', () => {
    expect([...sections().keys()].sort()).toEqual(
      bundledModules.map(({ manifest }) => manifest.id).sort(),
    );
  });

  test('each says its removal threshold, or that there is none and why (D-250 rule 6)', () => {
    for (const { manifest } of bundledModules) {
      const threshold = REMOVAL_THRESHOLD.exec(sections().get(manifest.id) ?? '')?.[1]
        ?.replace(/\s+/g, ' ')
        .trim();
      expect({ id: manifest.id, said: threshold !== undefined && threshold.length > 0 }).toEqual({
        id: manifest.id,
        said: true,
      });
      if (threshold?.toLowerCase().startsWith('none')) {
        expect({ id: manifest.id, because: /^none, because \S/i.test(threshold) }).toEqual({
          id: manifest.id,
          because: true,
        });
      }
    }
  });
});
