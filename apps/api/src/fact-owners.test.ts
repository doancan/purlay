/**
 * The fact types of the contract and the modules' manifests are the same list, each type owned once (D-283 §3). `FACTS` is
 * `@purlay/types`'s, and a module's `publishes` is its manifest's: a type declared and published by nobody, or published and
 * declared nowhere, fails here instead of reaching a consumer that waits for it.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { FACTS, defineFact, factOwnerProblems, type FactDeclaration } from '@purlay/types';
import { registry } from './composition';

const moduleIds = registry.bundled.map((manifest) => manifest.id);

/** Each side's types that the other lacks, owner by owner: declared in the contract and not published, and the other way. */
const unmatched = (
  facts: readonly FactDeclaration[],
  published: ReadonlyMap<string, readonly string[]>,
): string[] => {
  const declared = new Map<string, string[]>();
  for (const { type, owner } of facts) declared.set(owner, [...(declared.get(owner) ?? []), type]);
  return [...new Set([...declared.keys(), ...published.keys()])]
    .filter((owner) => owner !== 'core')
    .flatMap((owner) => {
      const mine = declared.get(owner) ?? [];
      const theirs = published.get(owner) ?? [];
      return [
        ...mine
          .filter((type) => !theirs.includes(type))
          .map((type) => `${type} is declared and "${owner}" does not publish it`),
        ...theirs
          .filter((type) => !mine.includes(type))
          .map((type) => `${type} is published by "${owner}" and declared nowhere`),
      ];
    });
};

describe('the facts of the build', () => {
  test('are named for their owners, once each', () => {
    expect(factOwnerProblems(FACTS, moduleIds)).toEqual([]);
  });

  test('are the ones the modules publish', () => {
    const published = new Map(
      registry.bundled.map((manifest) => [manifest.id, manifest.publishes ?? []]),
    );
    expect(unmatched(FACTS, published)).toEqual([]);
  });

  test('a declaration nobody publishes, and a publication nobody declares, are both found', () => {
    const declaration = defineFact({
      type: 'notes.created',
      owner: 'notes',
      schema: Type.Object({}),
    });
    expect(unmatched([declaration], new Map([['notes', []]]))).toEqual([
      'notes.created is declared and "notes" does not publish it',
    ]);
    expect(unmatched([], new Map([['notes', ['notes.created']]]))).toEqual([
      'notes.created is published by "notes" and declared nowhere',
    ]);
  });
});
