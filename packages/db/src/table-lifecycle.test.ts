/**
 * Every table has a decision about its erasure and its retention (D-27, D-139, D-250), made where the table is
 * added and not left to `DATA.md`'s prose. The type holds this at compile time; this holds it where the compiler is
 * not run, and says where to decide.
 */
import { describe, expect, test } from 'bun:test';
import { TABLE_LIFECYCLE, type TableLifecycle } from './table-lifecycle';
import { TABLE_OWNERS } from './table-owners';

/** The decisions, asked about names as strings: the schema's own keys are a closed type. */
const lifecycle: Readonly<Record<string, TableLifecycle | undefined>> = TABLE_LIFECYCLE;

/**
 * The tables whose erasure does not reach the person's rows today. **This list may only shrink**: a new gap is a
 * table somebody did not finish, and is not added here to make the test pass.
 */
const KNOWN_ERASURE_GAPS: readonly string[] = ['github_app_installations'];

describe('the lifecycle of each table', () => {
  test('is decided for every owned table, and for no other', () => {
    const undecided = Object.keys(TABLE_OWNERS).filter((table) => lifecycle[table] === undefined);
    if (undecided.length > 0) {
      throw new Error(
        `no erasure and retention decision for ${undecided.join(', ')}: decide them in packages/db/src/table-lifecycle.ts`,
      );
    }
    expect(Object.keys(lifecycle).sort()).toEqual(Object.keys(TABLE_OWNERS).sort());
  });

  test('says why wherever it says a table holds nobody, keeps its rows or does not erase them', () => {
    const reasonOf = (decision: string | Readonly<Record<string, string>>): string | undefined =>
      typeof decision === 'string' ? 'given' : Object.values(decision)[0];
    const unsaid = Object.entries(lifecycle).flatMap(([table, decided]) => {
      if (decided === undefined) return [];
      const reasons = [reasonOf(decided.erasure), reasonOf(decided.retention)];
      return reasons.some((reason) => reason === undefined || reason.trim() === '') ? [table] : [];
    });
    expect(unsaid).toEqual([]);
  });

  test('names the tables the erasure does not reach, and only those', () => {
    const gaps = Object.entries(lifecycle)
      .filter(([, decided]) => typeof decided?.erasure === 'object' && 'gap' in decided.erasure)
      .map(([table]) => table);
    expect(gaps.sort()).toEqual([...KNOWN_ERASURE_GAPS].sort());
  });
});
