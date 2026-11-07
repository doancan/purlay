/**
 * A fact type is named for its owner and has one (`MODULES.md` §4, D-283 §3). The lists the build carries are empty until a module
 * publishes, so the rule is held here against lists that are not: a check that has only ever passed on nothing has not been tried.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import {
  CORE_FACTS,
  FACTS,
  FACT_HOLD_DAYS_MAX,
  defineFact,
  factOwnerProblems,
  type FactDeclaration,
} from './facts';

const fact = (
  type: string,
  owner: string,
  absent: FactDeclaration['absent'] = 'drop',
): ReturnType<typeof defineFact> => defineFact({ type, owner, absent, schema: Type.Object({}) });

describe('who owns each fact type', () => {
  test('the build carries none yet, and the core owns the ones it will', () => {
    expect(FACTS).toEqual([...CORE_FACTS]);
    expect(factOwnerProblems(FACTS, ['chat', 'issues'])).toEqual([]);
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

  test('is never held for no time, for longer than the table keeps it, or for part of a day', () => {
    for (const days of [0, -1, FACT_HOLD_DAYS_MAX + 1, 1.5, Number.NaN]) {
      expect(factOwnerProblems([fact('notes.a', 'notes', { holdDays: days })], ['notes'])).toEqual([
        `the fact "notes.a" is held ${String(days)} days when its consumer is off: a whole number from 1 to ${String(FACT_HOLD_DAYS_MAX)}`,
      ]);
    }
  });
});
