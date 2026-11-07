/**
 * What the registry holds of how modules tell one another things (`MODULES.md` §4, D-283 §3): the facts a module publishes, the
 * facts it consumes and the capabilities it uses, checked over the modules a build carries so that a wrong declaration fails the
 * build's own tests and not an operator's boot. Every case is a fake module, since the two real ones declare none of it.
 */
import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { defineFact } from '@purlay/types';
import { factTypes } from './core-claims';
import type { ModuleManifest } from './manifest';
import { ModuleConfigError, moduleRegistry } from './registry';

const module = (id: string, rest: Partial<ModuleManifest> = {}): ModuleManifest => ({
  id,
  requires: [],
  optional: [],
  degrades: Object.fromEntries(
    (rest.optional ?? []).map((partner) => [partner, `it does without ${partner}`]),
  ),
  provides: [],
  budget: { none: 'a test module with no queries of its own' },
  ...rest,
});

const problemsOf = (
  manifests: readonly ModuleManifest[],
  core: Parameters<typeof moduleRegistry>[1] = {},
): readonly string[] => {
  try {
    moduleRegistry(manifests, core);
  } catch (error) {
    if (error instanceof ModuleConfigError) return error.problems;
    throw error;
  }
  return [];
};

describe('the facts a module publishes', () => {
  test('are its own, named for it', () => {
    expect(problemsOf([module('notes', { publishes: ['notes.created', 'notes.moved'] })])).toEqual(
      [],
    );
  });

  test('may not carry another owner’s name, or be no name at all', () => {
    expect(problemsOf([module('notes', { publishes: ['wiki.created'] })])).toEqual([
      '"notes" publishes "wiki.created", which is not named "notes.<what>"',
    ]);
    expect(problemsOf([module('notes', { publishes: ['notes.', 'Notes.Created'] })])).toHaveLength(
      2,
    );
  });

  test('are published by one module: two cannot both own a type', () => {
    expect(
      problemsOf([
        module('notes', { publishes: ['notes.created'] }),
        module('wiki', { publishes: ['notes.created'] }),
      ]),
    ).toContain('"notes" and "wiki" both own the fact "notes.created"');
  });

  test('are not the core’s: a module cannot take a type the core publishes', () => {
    expect(
      problemsOf([module('notes', { publishes: ['notes.created'] })], {
        facts: ['notes.created'],
      }),
    ).toEqual(['"notes" owns the fact "notes.created", which is the core\'s']);
  });
});

describe('the facts a module consumes', () => {
  test('are published by a module of the build, or by the core', () => {
    expect(
      problemsOf(
        [
          module('notes', { publishes: ['notes.created'] }),
          module('wiki', { consumes: ['notes.created', 'core.moved'] }),
        ],
        { facts: ['core.moved'] },
      ),
    ).toEqual([]);
  });

  test('may not be a fact nothing in the build publishes', () => {
    expect(problemsOf([module('wiki', { consumes: ['notes.created'] })])).toEqual([
      '"wiki" consumes "notes.created", which nothing in this build publishes',
    ]);
  });

  test('may not be a malformed name', () => {
    expect(problemsOf([module('wiki', { consumes: ['Notes'] })])).toContain(
      '"wiki" consumes "Notes", which is not a fact type like "notes.created"',
    );
  });
});

describe('the capabilities a module uses', () => {
  const chat = module('chat', { provides: ['chat.channel-access'] });

  test('are provided by a partner it requires or lists as optional', () => {
    expect(
      problemsOf([chat, module('issues', { optional: ['chat'], uses: ['chat.channel-access'] })]),
    ).toEqual([]);
    expect(
      problemsOf([chat, module('issues', { requires: ['chat'], uses: ['chat.channel-access'] })]),
    ).toEqual([]);
  });

  test('may not be provided by a module that is neither', () => {
    expect(problemsOf([chat, module('issues', { uses: ['chat.channel-access'] })])).toEqual([
      '"issues" uses "chat.channel-access", provided by "chat", which it neither requires nor lists as optional',
    ]);
  });

  test('may not be one nothing in the build provides', () => {
    expect(problemsOf([module('issues', { uses: ['chat.channel-access'] })])).toEqual([
      '"issues" uses "chat.channel-access", which nothing in this build provides',
    ]);
  });

  test('may not be a malformed name', () => {
    expect(problemsOf([module('issues', { uses: ['channel'] })])).toContain(
      '"issues" uses "channel", which is not a capability name like "chat.post-system-message"',
    );
  });

  test('says every problem at once', () => {
    expect(
      problemsOf([
        module('notes', { publishes: ['wiki.x'] }),
        module('wiki', { consumes: ['gone.x'], uses: ['gone.y'] }),
      ]),
    ).toHaveLength(3);
  });
});

describe('the facts the core claims', () => {
  test('are the types of its declarations, so a module cannot take one', () => {
    const declared = [
      defineFact({ type: 'core.moved', owner: 'core', absent: 'drop', schema: Type.Object({}) }),
      defineFact({ type: 'core.renamed', owner: 'core', absent: 'drop', schema: Type.Object({}) }),
    ];
    expect(factTypes(declared)).toEqual(['core.moved', 'core.renamed']);
    expect(factTypes([])).toEqual([]);
  });
});
