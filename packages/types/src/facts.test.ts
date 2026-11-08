/**
 * A fact type is named for its owner and has one (`MODULES.md` §4, D-283 §3). The lists the build carries are empty until a module
 * publishes, so the rule is held here against lists that are not: a check that has only ever passed on nothing has not been tried.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import {
  FACT_HOLD_DAYS_MAX,
  defineFact,
  readsEarlierShape,
  type FactDeclaration,
} from './fact-declaration';
import { CORE_FACTS, FACTS, factOwnerProblems } from './facts';
import { MODULE_IDS } from './modules';

const fact = (
  type: string,
  owner: string,
  absent: FactDeclaration['absent'] = 'drop',
): ReturnType<typeof defineFact> => defineFact({ type, owner, absent, schema: Type.Object({}) });

describe('who owns each fact type', () => {
  test('of the build are the core’s and its modules’, each named for an owner the build has', () => {
    expect(FACTS.filter(({ owner }) => owner === 'core')).toEqual([...CORE_FACTS]);
    expect(factOwnerProblems(FACTS, MODULE_IDS)).toEqual([]);
  });

  test('a type is named for its owner, who is the core or a module of the build', () => {
    expect(
      factOwnerProblems([fact('notes.created', 'notes'), fact('core.moved', 'core')], ['notes']),
    ).toEqual([]);
    expect(factOwnerProblems([fact('wiki.created', 'notes')], ['notes'])).toEqual([
      'the fact "wiki.created" is owned by "notes", so it must be named "notes.<what>"',
    ]);
    expect(factOwnerProblems([fact('wiki.created', 'wiki')], ['notes'])).toEqual([
      'the fact "wiki.created" is owned by "wiki", which is neither the core nor a module of this build',
    ]);
  });

  test('a type is declared once', () => {
    expect(
      factOwnerProblems(
        [fact('notes.created', 'notes'), fact('notes.created', 'notes')],
        ['notes'],
      ),
    ).toEqual(['the fact "notes.created" is declared twice']);
  });
});

describe('what becomes of a fact when its consumer is not run', () => {
  test('is dropped, or held for a whole number of days up to the most the table is kept', () => {
    expect(
      factOwnerProblems(
        [
          fact('notes.a', 'notes', 'drop'),
          fact('notes.b', 'notes', { holdDays: 1 }),
          fact('notes.c', 'notes', { holdDays: FACT_HOLD_DAYS_MAX }),
        ],
        ['notes'],
      ),
    ).toEqual([]);
  });

  test('has a shape that counts from one', () => {
    const shaped = (shape: number): ReturnType<typeof defineFact> =>
      defineFact({ ...fact('notes.a', 'notes'), shape });
    expect(factOwnerProblems([shaped(1), shaped(2)].slice(0, 1), ['notes'])).toEqual([]);
    expect(factOwnerProblems([shaped(7)], ['notes'])).toEqual([]);
    for (const shape of [0, -1, 1.5, Number.NaN]) {
      expect(factOwnerProblems([shaped(shape)], ['notes'])).toEqual([
        `the fact "notes.a" has the shape ${String(shape)}: a whole number from 1`,
      ]);
    }
  });

  test('reads only shapes earlier than its own, and a reader refuses a payload its shape does not fit', () => {
    const reader = readsEarlierShape(Type.Object({ id: Type.String() }), (note) => note);
    const reading = (shape: number, earlier: number): ReturnType<typeof defineFact> =>
      defineFact({ ...fact('notes.a', 'notes'), shape, reads: { [earlier]: reader } });
    expect(factOwnerProblems([reading(3, 1), reading(3, 2)], ['notes'])).toEqual([
      'the fact "notes.a" is declared twice',
    ]);
    for (const [shape, earlier] of [
      [2, 2],
      [2, 3],
      [2, 0],
    ] as const) {
      expect(factOwnerProblems([reading(shape, earlier)], ['notes'])).toEqual([
        `the fact "notes.a" reads the shape ${String(earlier)}, which is not an earlier shape than its own`,
      ]);
    }
    expect(reader.upcast({ id: 'a' })).toEqual({ id: 'a' });
    expect(() => reader.upcast({ id: 1 })).toThrow('does not fit');
  });

  test('is never held for no time, for longer than the table keeps it, or for part of a day', () => {
    for (const days of [0, -1, FACT_HOLD_DAYS_MAX + 1, 1.5, Number.NaN]) {
      expect(factOwnerProblems([fact('notes.a', 'notes', { holdDays: days })], ['notes'])).toEqual([
        `the fact "notes.a" is held ${String(days)} days when its consumer is off: a whole number from 1 to ${String(FACT_HOLD_DAYS_MAX)}`,
      ]);
    }
  });
});
