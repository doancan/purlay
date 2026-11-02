/**
 * Which modules a process runs, and the ways a setting or a bundle cannot start (D-250).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ModuleManifest } from './manifest';
import { ModuleConfigError, RESERVED_MODULE_IDS, moduleRegistry } from './registry';

const module = (id: string, rest: Partial<ModuleManifest> = {}): ModuleManifest => ({
  id,
  requires: [],
  optional: [],
  provides: [],
  ...rest,
});

const problemsOf = (run: () => unknown): readonly string[] => {
  try {
    run();
  } catch (error) {
    if (error instanceof ModuleConfigError) return error.problems;
    throw error;
  }
  throw new Error('expected a ModuleConfigError, and nothing was thrown');
};

const idsOf = (modules: readonly ModuleManifest[]): string[] => modules.map((m) => m.id);

describe('a build with no modules', () => {
  const registry = moduleRegistry([]);

  test('runs none, whatever is set, and says so when something is asked for', () => {
    expect(registry.resolve(undefined)).toEqual([]);
    expect(registry.resolve('')).toEqual([]);
    expect(problemsOf(() => registry.resolve('chat'))).toEqual([
      'MODULES names "chat", which this build does not have (it has: none)',
    ]);
  });
});

describe('the setting', () => {
  const registry = moduleRegistry([
    module('chat'),
    module('issues', { optional: ['chat'] }),
    module('notes'),
  ]);

  test('unset is every module the build has, partners first', () => {
    expect(idsOf(registry.resolve(undefined))).toEqual(['chat', 'notes', 'issues']);
  });

  test('blank is unset, which is every module; none is the core alone', () => {
    expect(idsOf(registry.resolve(''))).toEqual(idsOf(registry.resolve(undefined)));
    expect(idsOf(registry.resolve('   '))).toEqual(idsOf(registry.resolve(undefined)));
    expect(registry.resolve('none')).toEqual([]);
    expect(registry.resolve(' none ')).toEqual([]);
  });

  test('names a subset, and a module runs without a partner it only uses', () => {
    expect(idsOf(registry.resolve('issues'))).toEqual(['issues']);
    expect(idsOf(registry.resolve(' notes , chat '))).toEqual(['chat', 'notes']);
  });

  test('says every problem at once: an unknown id, a repeat and an empty item', () => {
    expect(problemsOf(() => registry.resolve('chat,wiki,chat,,notes'))).toEqual([
      'MODULES names "wiki", which this build does not have (it has: chat, issues, notes)',
      'MODULES names "chat" twice',
      'MODULES has an empty item: a doubled or trailing comma',
    ]);
  });

  test('does not guess at a different spelling', () => {
    expect(problemsOf(() => registry.resolve('Chat'))).toEqual([
      'MODULES names "Chat", which this build does not have (it has: chat, issues, notes)',
    ]);
  });

  test('refuses a module whose requirement is not enabled, naming both', () => {
    const needs = moduleRegistry([module('chat'), module('digest', { requires: ['chat'] })]);
    expect(problemsOf(() => needs.resolve('digest'))).toEqual([
      '"digest" requires "chat", which MODULES does not enable',
    ]);
    expect(idsOf(needs.resolve('digest,chat'))).toEqual(['chat', 'digest']);
  });
});

describe('the start order', () => {
  test('puts a module after what it requires and after an optional partner that is enabled', () => {
    const registry = moduleRegistry([
      module('a', { requires: ['b'] }),
      module('b', { optional: ['c'] }),
      module('c'),
    ]);
    expect(idsOf(registry.resolve(undefined))).toEqual(['c', 'b', 'a']);
    expect(idsOf(registry.resolve('a,b'))).toEqual(['b', 'a']);
  });

  test('is the same however the bundle and the setting are written', () => {
    const modules = [module('zeta'), module('alpha'), module('mid', { optional: ['zeta'] })];
    const forward = idsOf(moduleRegistry(modules).resolve(undefined));
    const backward = idsOf(moduleRegistry([...modules].reverse()).resolve('mid,alpha,zeta'));
    expect(forward).toEqual(['alpha', 'zeta', 'mid']);
    expect(backward).toEqual(forward);
  });
});

describe('a bundle that cannot be trusted', () => {
  test('refuses ids that are malformed, reserved or repeated, all together', () => {
    expect(
      problemsOf(() =>
        moduleRegistry([module('Chat'), module('workspaces'), module('notes'), module('notes')]),
      ),
    ).toEqual([
      '"Chat" is not a module id: lowercase letters, digits and hyphens, starting with a letter',
      '"workspaces" is a path the core owns and cannot be a module id',
      'two modules are called "notes"',
    ]);
  });

  test('refuses a partner that is not in the build, itself, or both kinds at once', () => {
    expect(
      problemsOf(() =>
        moduleRegistry([
          module('a', { requires: ['ghost'] }),
          module('b', { optional: ['b'] }),
          module('c'),
          module('d', { requires: ['c'], optional: ['c'] }),
        ]),
      ),
    ).toEqual([
      '"a" requires "ghost", which is not a module of this build',
      '"b" lists itself under optional',
      '"d" lists "c" as both required and optional',
    ]);
  });

  test('refuses a cycle, optional partners included, naming who is in it', () => {
    expect(
      problemsOf(() =>
        moduleRegistry([
          module('a', { requires: ['b'] }),
          module('b', { optional: ['a'] }),
          module('c'),
        ]),
      ),
    ).toEqual(['these modules wait on one another and have no start order: a, b']);
  });

  test('refuses a capability two modules provide, or one that is not named like a capability', () => {
    expect(
      problemsOf(() =>
        moduleRegistry([
          module('a', { provides: ['a.post'] }),
          module('b', { provides: ['a.post', 'loose'] }),
        ]),
      ),
    ).toEqual([
      '"a" and "b" both provide "a.post"',
      '"b" provides "loose", which is not a capability name like "chat.post-system-message"',
    ]);
  });

  test('does not change when its caller changes the array it was given', () => {
    const given = [module('a')];
    const registry = moduleRegistry(given);
    given.push(module('b'));
    expect(idsOf(registry.bundled)).toEqual(['a']);
    expect(idsOf(registry.resolve(undefined))).toEqual(['a']);
  });
});

describe('the ids the core owns', () => {
  const documented = (): Set<string> => {
    // Every route row of API.md names its path in backticks, `/api/<segment>…`, or the unprefixed
    // addresses of the first rows (`/ws`, `/health`, …).
    const api = readFileSync('docs/API.md', 'utf8');
    const segments = new Set<string>();
    for (const match of api.matchAll(/`\/(?:api\/)?([a-z][a-z-]*)/g)) {
      if (match[1] !== undefined) segments.add(match[1]);
    }
    return segments;
  };

  test('include the first path segment of every route API.md documents', () => {
    const missing = [...documented()].filter((segment) => !RESERVED_MODULE_IDS.has(segment));
    expect(missing).toEqual([]);
  });

  test('are themselves well formed, so a reserved id is never refused for the wrong reason', () => {
    for (const id of RESERVED_MODULE_IDS) expect(id).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
  });
});
