/**
 * A field of the manifest or a slot of a bundled module that no document names cannot ship (`MODULES.md` §2 and §12, `CONTRIBUTING.md`
 * §6.2). The names are read from the two types, so a field added to either fails here until the manifest section or the glossary
 * says what it is; what they say is for a reviewer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '../../..');
const modules = readFileSync(join(ROOT, 'docs/MODULES.md'), 'utf8');

/** The fields of `export interface <name> { ... }` in a file: the names at the interface's own indentation. */
const fieldsOf = (file: string, name: string): string[] => {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const start = source.indexOf(`export interface ${name} {`);
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('\n}\n', start));
  return [...body.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((match) => match[1] ?? '');
};

/** The text of the sections headed by these words, whatever number they carry. */
const sections = (...headings: string[]): string =>
  headings
    .map((heading) => {
      const at = modules.search(new RegExp(`^## \\d+\\. ${heading}$`, 'm'));
      expect(at).toBeGreaterThan(-1);
      const rest = modules.slice(at + 3);
      const next = rest.search(/^## /m);
      return next === -1 ? rest : rest.slice(0, next);
    })
    .join('\n');

describe('the fields the code declares are the fields the rulebook names', () => {
  const described = sections('The manifest', 'Glossary');

  test.each([
    ['apps/api/src/platform/module-kit/manifest.ts', 'ModuleManifest'],
    ['apps/api/src/composition.ts', 'BundledModule'],
  ])('every field of %s %s is named in the manifest section or the glossary', (file, type) => {
    const fields = fieldsOf(file, type);
    expect(fields.length).toBeGreaterThan(10);
    expect(fields.filter((field) => !described.includes(`\`${field}\``))).toEqual([]);
  });
});
