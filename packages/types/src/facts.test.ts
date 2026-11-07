/**
 * A fact type is named for its owner and has one (`MODULES.md` §4, D-283 §3). The lists the build carries are empty until a module
 * publishes, so the rule is held here against lists that are not: a check that has only ever passed on nothing has not been tried.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { CORE_FACTS, FACTS, defineFact, factOwnerProblems } from './facts';

const fact = (type: string, owner: string): ReturnType<typeof defineFact> =>
  defineFact({ type, owner, schema: Type.Object({}) });

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
