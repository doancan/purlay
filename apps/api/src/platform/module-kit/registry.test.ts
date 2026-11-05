/**
 * Which modules a process runs, and the ways a setting or a bundle cannot start (D-250).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ModuleManifest } from './manifest';
import { CORE_CLAIMS } from './core-claims';
import { ModuleConfigError, RESERVED_MODULE_IDS, moduleRegistry } from './registry';

const module = (id: string, rest: Partial<ModuleManifest> = {}): ModuleManifest => ({
  id,
  requires: [],
  optional: [],
  provides: [],
  budget: { none: 'a test module with no queries of its own' },
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
      'MODULES names "Chat", which is not a module id: lowercase letters, digits and hyphens, starting with a letter',
    ]);
  });

  test('says none must stand alone when it is listed with a module', () => {
    expect(problemsOf(() => registry.resolve('none,chat'))).toEqual([
      'MODULES has "none" with other items: none must stand alone',
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

describe('what two modules, or a module and the core, both claim', () => {
  const core = {
    routes: ['/api/me', '/api/workspaces/:workspaceId/members'],
    jobs: ['sweep:sessions'],
    frames: ['PING'],
    events: ['PONG'],
  };

  test('a route template inside another’s subtree, or the same one, is an overlap, named with both', () => {
    expect(
      problemsOf(() =>
        moduleRegistry([
          module('chat', { routes: ['/api/things/**'] }),
          module('notes', { routes: ['/api/things/:id/x', '/api/other'] }),
        ]),
      ),
    ).toEqual([
      '"chat" and "notes" both own routes that overlap: "/api/things/**" and "/api/things/:id/x"',
    ]);
    expect(
      problemsOf(() =>
        moduleRegistry([
          module('chat', { routes: ['/api/a/:id'] }),
          module('notes', { routes: ['/api/a/b'] }),
        ]),
      ),
    ).toHaveLength(1);
  });

  test('a retention job is a job: two modules cannot both name one, nor take one the core has', () => {
    expect(
      problemsOf(() =>
        moduleRegistry([
          module('chat', { retention: ['purge:x'] }),
          module('notes', { jobs: ['purge:x'] }),
        ]),
      ),
    ).toEqual(['"chat" and "notes" both own the job "purge:x"']);
    expect(
      problemsOf(() => moduleRegistry([module('notes', { retention: ['sweep:sessions'] })], core)),
    ).toEqual(['"notes" owns the job "sweep:sessions", which is the core\'s']);
  });

  test('a job, a socket operation and a server event two modules both list are each a problem', () => {
    expect(
      problemsOf(() =>
        moduleRegistry([
          module('chat', { jobs: ['mail:x'], frames: ['SEND'], events: ['SENT'] }),
          module('notes', { jobs: ['mail:x'], frames: ['SEND'], events: ['SENT'] }),
        ]),
      ),
    ).toEqual([
      '"chat" and "notes" both own the job "mail:x"',
      '"chat" and "notes" both own the socket operation "SEND"',
      '"chat" and "notes" both own the server event "SENT"',
    ]);
  });

  test('what the core claims cannot be a module’s, in each of the four kinds', () => {
    expect(
      problemsOf(() =>
        moduleRegistry(
          [
            module('chat', {
              routes: ['/api/me', '/api/workspaces/:workspaceId/**'],
              jobs: ['sweep:sessions'],
              frames: ['PING'],
              events: ['PONG'],
            }),
          ],
          core,
        ),
      ),
    ).toEqual([
      '"chat" owns the route "/api/me", which overlaps the core\'s "/api/me"',
      '"chat" owns the route "/api/workspaces/:workspaceId/**", which overlaps the core\'s "/api/workspaces/:workspaceId/members"',
      '"chat" owns the job "sweep:sessions", which is the core\'s',
      '"chat" owns the socket operation "PING", which is the core\'s',
      '"chat" owns the server event "PONG", which is the core\'s',
    ]);
  });

  test('modules that claim different things, beside the core, are a sound build', () => {
    const registry = moduleRegistry(
      [
        module('chat', { routes: ['/api/a/**'], jobs: ['j1'], frames: ['F1'], events: ['E1'] }),
        module('notes', { routes: ['/api/b'], jobs: ['j2'], frames: ['F2'], events: ['E2'] }),
      ],
      core,
    );
    expect(idsOf(registry.bundled)).toEqual(['chat', 'notes']);
  });
});

describe('a module’s share of the database (D-250 rule 7)', () => {
  test('a manifest that does not say it does not compile, and the registry refuses it by id', () => {
    // @ts-expect-error a manifest without `budget` is not a ModuleManifest
    const incomplete: ModuleManifest = { id: 'issues', requires: [], optional: [], provides: [] };
    expect(problemsOf(() => moduleRegistry([incomplete]))).toEqual([
      '"issues" does not say what it may take of the database: give it a `budget`, a share of the pool or `none` with the reason',
    ]);
  });

  test('`none` with no reason is refused: leaving the share out must be said, and said why', () => {
    expect(
      problemsOf(() => moduleRegistry([module('issues', { budget: { none: '  ' } })])),
    ).toEqual(['"issues" declares `budget: none` without a reason']);
  });

  test('a share must give the module a connection and leave the others one, for every pool size', () => {
    const sharing = (of: (poolMax: number) => number): Partial<ModuleManifest> => ({
      budget: {
        poolShare: (poolMax) => ({
          maxConcurrent: of(poolMax),
          queueTimeoutMs: 1,
          statementTimeoutMs: 1,
        }),
      },
    });
    expect(
      problemsOf(() =>
        moduleRegistry([
          module(
            'issues',
            sharing(() => 0),
          ),
        ]),
      ),
    ).toEqual([
      '"issues" has a share of 0 connections in a pool of 1: it needs at least one, and the others one too (a pool of one has none to leave)',
    ]);
    expect(
      problemsOf(() =>
        moduleRegistry([
          module(
            'issues',
            sharing((pool) => pool),
          ),
        ]),
      ),
    ).toEqual([
      '"issues" has a share of 2 connections in a pool of 2: it needs at least one, and the others one too (a pool of one has none to leave)',
    ]);
    expect(() =>
      moduleRegistry([
        module(
          'issues',
          sharing((pool) => Math.max(1, pool - 1)),
        ),
      ]),
    ).not.toThrow();
  });
});

describe('the permissions and audit actions a module declares', () => {
  const notes = (rest: Partial<ModuleManifest> = {}): ModuleManifest =>
    module('notes', {
      permissions: [{ name: 'notes.publish', minimumRole: 'admin' }],
      auditActions: [{ read: 'notes.publish', actions: ['note.created'] }],
      ...rest,
    });

  test('a sound declaration registers', () => {
    expect(() => moduleRegistry([notes()], CORE_CLAIMS)).not.toThrow();
  });

  test('a permission is named for its module, once', () => {
    expect(
      problemsOf(() =>
        moduleRegistry([
          notes({
            permissions: [
              { name: 'audit.read', minimumRole: 'member' },
              { name: 'notes.Publish', minimumRole: 'admin' },
              { name: 'notes.publish', minimumRole: 'admin' },
              { name: 'notes.publish', minimumRole: 'owner' },
            ],
            auditActions: [],
          }),
        ]),
      ),
    ).toEqual([
      '"notes" declares the permission "audit.read", which is not named "notes.<what>"',
      '"notes" declares the permission "notes.Publish", which is not named "notes.<what>"',
      '"notes" declares the permission "notes.publish" twice',
    ]);
  });

  test('two modules, or a module and the core, cannot both own a permission or an audit action', () => {
    expect(
      problemsOf(() =>
        moduleRegistry(
          [
            notes(),
            module('wiki', {
              permissions: [{ name: 'wiki.edit', minimumRole: 'member' }],
              auditActions: [{ read: 'audit.read', actions: ['note.created', 'member.joined'] }],
            }),
          ],
          CORE_CLAIMS,
        ),
      ),
    ).toEqual([
      '"notes" and "wiki" both own the audit action "note.created"',
      '"wiki" owns the audit action "member.joined", which is the core\'s',
    ]);
  });

  test("the permission that reads an action is the core's or the module's own, never another module's", () => {
    expect(
      problemsOf(() =>
        moduleRegistry(
          [
            notes({ auditActions: [{ read: 'wiki.edit', actions: ['note.created'] }] }),
            module('wiki', { permissions: [{ name: 'wiki.edit', minimumRole: 'member' }] }),
          ],
          CORE_CLAIMS,
        ),
      ),
    ).toEqual([
      '"notes" has audit actions read by "wiki.edit", which is neither the core\'s permission nor one of its own',
    ]);
  });

  test('an audit action is a noun and a past tense, as the trail names them', () => {
    expect(
      problemsOf(() =>
        moduleRegistry([
          notes({ auditActions: [{ read: 'notes.publish', actions: ['Created'] }] }),
        ]),
      ),
    ).toEqual(['"notes" lists the audit action "Created", which is not like "issue.created"']);
  });
});

describe('the notification kinds and search sources a module declares', () => {
  const kind = (type: string): NonNullable<ModuleManifest['notifications']>[number] => ({
    type,
    needsYou: true,
    pushed: true,
    mailed: false,
  });

  test('two modules cannot both send a kind or both own a source', () => {
    expect(
      problemsOf(() =>
        moduleRegistry(
          [
            module('notes', { notifications: [kind('note_shared')], searchSources: ['notes'] }),
            module('wiki', { notifications: [kind('note_shared')], searchSources: ['notes'] }),
          ],
          CORE_CLAIMS,
        ),
      ),
    ).toEqual([
      '"notes" and "wiki" both own the notification kind "note_shared"',
      '"notes" and "wiki" both own the search source "notes"',
    ]);
  });
});

describe('a module’s deadline (D-268)', () => {
  test('is left out, a whole number of milliseconds a client could wait for, or `none` with a reason', () => {
    expect(() => moduleRegistry([module('issues')])).not.toThrow();
    expect(() => moduleRegistry([module('issues', { deadline: { ms: 8_000 } })])).not.toThrow();
    expect(() =>
      moduleRegistry([module('issues', { deadline: { none: 'it streams a download' } })]),
    ).not.toThrow();
  });

  test('`none` with no reason, a deadline too short to be one and one past what a proxy would wait are refused by id', () => {
    expect(
      problemsOf(() => moduleRegistry([module('issues', { deadline: { none: ' ' } })])),
    ).toEqual(['"issues" declares `deadline: none` without a reason']);
    for (const ms of [0, 999, 120_001, 1.5, Number.NaN]) {
      expect(problemsOf(() => moduleRegistry([module('issues', { deadline: { ms } })]))).toEqual([
        `"issues" has a deadline of ${String(ms)} ms: it needs a whole number from 1000 to 120000`,
      ]);
    }
  });
});
