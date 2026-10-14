/**
 * DATA.md's data map names every table the instance has, each once — bound, not trusted (#85).
 *
 * The map is what an operator writes their records of processing from (D-28): a table the migrations
 * add and the map leaves out is personal data nobody was told about. The generated types are the
 * list of tables (D-45), so the map is held to them in both directions.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/** The tables of the generated `DB` interface. */
const generatedTables = (): string[] => {
  const schema = readFileSync(join(root, 'packages/db/src/schema.ts'), 'utf8');
  const body = /export interface DB \{([^}]*)\}/.exec(schema)?.[1];
  if (body === undefined) throw new Error('packages/db/src/schema.ts has no `DB` interface');
  return [...body.matchAll(/^\s*(\w+):/gm)].map((match) => match[1] ?? '');
};

/** The tables the map's rows name: the first cell of each row of §2's table. */
const mappedTables = (): string[] => {
  const document = readFileSync(join(root, 'docs/DATA.md'), 'utf8');
  const section = /## 2\. The data map\n([\s\S]*?)\n---/.exec(document)?.[1];
  if (section === undefined) throw new Error('docs/DATA.md has no "2. The data map" section');
  return [...section.matchAll(/^\| `(\w+)` \|/gm)].map((match) => match[1] ?? '');
};

describe('the data map', () => {
  test('finds the tables it compares, so an empty comparison cannot pass', () => {
    expect(generatedTables().length).toBeGreaterThan(20);
    expect(mappedTables().length).toBeGreaterThan(20);
  });

  test('names every table the migrations made, each once, and nothing else', () => {
    const mapped = mappedTables();
    expect(new Set(mapped).size).toBe(mapped.length);
    expect([...mapped].sort()).toEqual(generatedTables().sort());
  });
});
