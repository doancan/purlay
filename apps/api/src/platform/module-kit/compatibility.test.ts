import { describe, expect, test } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { defineFact, readsEarlierShape } from '@purlay/types';
import {
  factIncompatibilities,
  incompatibilities,
  releasedFactFrom,
  releasedFrom,
  unexcused,
  type ReleasedSnapshot,
} from './compatibility';
import type { ModuleManifest } from './manifest';

const manifest = (overrides: Partial<ModuleManifest> & { id: string }): ModuleManifest => ({
  requires: [],
  optional: [],
  degrades: {},
  provides: [],
  budget: { none: 'a test module' },
  ...overrides,
});

const unchanged = manifest({
  id: 'issues',
  optional: ['chat'],
  provides: ['issues.link'],
  routes: ['/api/issues/**'],
  jobs: ['issues:remind'],
  frames: ['ISSUE_WATCH'],
});
const before = [releasedFrom(unchanged)];

describe('what a release promised of a manifest', () => {
  test('nothing changed, nothing to say', () => {
    expect(incompatibilities(before, [unchanged])).toEqual([]);
  });

  test('a module, capability, route, job or optional partner added is not a break', () => {
    const richer = manifest({
      id: 'issues',
      optional: ['chat', 'notes'],
      provides: ['issues.link', 'issues.search'],
      routes: ['/api/issues/**', '/api/boards/**'],
      jobs: ['issues:remind', 'issues:digest'],
      frames: ['ISSUE_WATCH', 'ISSUE_TYPING'],
    });
    expect(incompatibilities(before, [richer, manifest({ id: 'notes' })])).toEqual([]);
  });

  test('an optional partner that becomes required is said, as such', () => {
    const now = manifest({ ...unchanged, requires: ['chat'], optional: [] });
    expect(incompatibilities(before, [now])).toEqual([
      "module 'issues' now requires 'chat', which the last release did not (it was optional)",
    ]);
  });

  test('a requirement of a module the release did not mention is said', () => {
    const now = manifest({ ...unchanged, requires: ['mail'] });
    expect(incompatibilities(before, [now])).toEqual([
      "module 'issues' now requires 'mail', which the last release did not ask of it",
    ]);
  });

  test('a requirement dropped is not a break', () => {
    const released = [releasedFrom(manifest({ id: 'issues', requires: ['chat'] }))];
    expect(incompatibilities(released, [manifest({ id: 'issues' })])).toEqual([]);
  });

  test('a capability, a route, a socket operation and a job that went are each said', () => {
    const now = manifest({ id: 'issues', optional: ['chat'] });
    expect(incompatibilities(before, [now])).toEqual([
      "module 'issues' no longer provides 'issues.link'",
      "module 'issues' no longer owns the route '/api/issues/**'",
      "module 'issues' no longer runs the job 'issues:remind'",
      "module 'issues' no longer owns the socket operation 'ISSUE_WATCH'",
    ]);
  });

  test('a module that is gone, or whose id changed, is said', () => {
    expect(incompatibilities(before, [manifest({ id: 'tickets' })])).toEqual([
      "module 'issues' is no longer in the build, or its id changed: operators name it in MODULES",
    ]);
  });
});

describe('what a release promised of who may have a module and what keeps its rows', () => {
  const promised = manifest({ id: 'notes', entitlement: 'always', retention: ['notes:purge'] });

  test('a module that was in every workspace and becomes a grant is said, as is the other way', () => {
    expect(incompatibilities([releasedFrom(promised)], [manifest({ id: 'notes' })])).toContain(
      "module 'notes' is now a grant of the workspace: the last release served it to every workspace",
    );
    expect(
      incompatibilities(
        [releasedFrom(manifest({ id: 'notes' }))],
        [manifest({ id: 'notes', entitlement: 'always' })],
      ),
    ).toEqual([
      "module 'notes' is now in every workspace: the last release let an operator withhold it",
    ]);
  });

  test('a manifest that says grant and one that says nothing are the same promise', () => {
    const explicit = manifest({ id: 'notes', entitlement: 'grant' });
    expect(incompatibilities([releasedFrom(explicit)], [manifest({ id: 'notes' })])).toEqual([]);
  });

  test('a retention job that went is said: its rows are kept for ever', () => {
    expect(incompatibilities([releasedFrom(promised)], [{ ...promised, retention: [] }])).toEqual([
      "module 'notes' no longer runs the retention job 'notes:purge'",
    ]);
  });

  test('a snapshot written before these were kept promised neither', () => {
    const { id, requires, optional, provides, routes, jobs, frames } = releasedFrom(promised);
    const old = [{ id, requires, optional, provides, routes, jobs, frames }];
    expect(incompatibilities(old, [manifest({ id: 'notes' })])).toEqual([]);
  });
});

describe('the facts a release promised', () => {
  const telling = manifest({
    id: 'notes',
    publishes: ['notes.created', 'notes.moved'],
    consumes: ['wiki.opened'],
    uses: ['wiki.access'],
  });
  const told = [releasedFrom(telling)];

  test('a fact published or consumed that is new, and a question dropped, are not breaks', () => {
    const now = manifest({
      id: 'notes',
      publishes: ['notes.created', 'notes.moved', 'notes.pinned'],
      consumes: ['wiki.opened', 'wiki.closed'],
    });
    expect(incompatibilities(told, [now])).toEqual([]);
  });

  test('a fact that is no longer published, and one that is no longer consumed, are each said', () => {
    const now = manifest({ id: 'notes', publishes: ['notes.created'] });
    expect(incompatibilities(told, [now])).toEqual([
      "module 'notes' no longer publishes the fact 'notes.moved'",
      "module 'notes' no longer consumes the fact 'wiki.opened'",
    ]);
  });

  test('a snapshot written before facts existed promised none', () => {
    const { id, requires, optional, provides, routes, jobs, frames } = releasedFrom(telling);
    const old = [{ id, requires, optional, provides, routes, jobs, frames }];
    expect(incompatibilities(old, [manifest({ id: 'notes' })])).toEqual([]);
  });
});

describe('the shapes of a fact a release wrote', () => {
  const first = Type.Object({ id: Type.String() });
  const second = Type.Object({ id: Type.String(), folder: Type.String() });
  const declared = (
    shape: number | undefined,
    reads: readonly number[] = [],
  ): ReturnType<typeof defineFact> =>
    defineFact({
      type: 'notes.created',
      owner: 'notes',
      absent: 'drop',
      schema: shape === 2 ? second : first,
      ...(shape === undefined ? {} : { shape }),
      reads: Object.fromEntries(reads.map((n) => [n, readsEarlierShape(first, (note) => note)])),
    });
  const released = [releasedFactFrom(declared(undefined))];

  test('a fact unchanged, with an optional field added or with a new shape that reads the old, is not a break', () => {
    expect(factIncompatibilities(released, [declared(undefined)])).toEqual([]);
    expect(factIncompatibilities(released, [declared(2, [1])])).toEqual([]);
    expect(factIncompatibilities(released, [])).toEqual([]);
  });

  test('a new shape that does not read the one the release wrote is said', () => {
    expect(factIncompatibilities(released, [declared(2)])).toEqual([
      "the fact 'notes.created' no longer reads the shape 1",
    ]);
  });

  test('a reader the release kept and this build drops is said, as is a shape that went back', () => {
    const wrote = [releasedFactFrom(declared(2, [1]))];
    expect(factIncompatibilities(wrote, [declared(2)])).toEqual([
      "the fact 'notes.created' no longer reads the shape 1",
    ]);
    expect(factIncompatibilities(wrote, [declared(undefined)])).toEqual([
      "the fact 'notes.created' no longer reads the shape 2",
    ]);
  });

  test('is kept for the release as the shape, the sorted shapes read and a digest of each schema', () => {
    const kept = releasedFactFrom(declared(2, [1]));
    expect(kept).toMatchObject({ type: 'notes.created', shape: 2, reads: [1] });
    expect(Object.keys(kept.schemas ?? {})).toEqual(['1', '2']);
    expect(kept.schemas?.['1']).toMatch(/^[0-9a-f]{64}$/);
    expect(kept.schemas?.['1']).not.toBe(kept.schemas?.['2']);
  });
});

describe('the schema of a fact a release wrote', () => {
  const written = Type.Object({ id: Type.String() });
  const fact = (
    schema: ReturnType<typeof Type.Object>,
    shape?: number,
    reader?: ReturnType<typeof Type.Object>,
  ): ReturnType<typeof defineFact> =>
    defineFact({
      type: 'notes.created',
      owner: 'notes',
      absent: 'drop',
      schema,
      ...(shape === undefined ? {} : { shape }),
      ...(reader === undefined ? {} : { reads: { 1: readsEarlierShape(reader, (note) => note) } }),
    });
  const released = [releasedFactFrom(fact(written))];

  test('a new required field at the same shape is said: the older node refuses the row', () => {
    const wider = Type.Object({ id: Type.String(), folder: Type.String() });
    expect(factIncompatibilities(released, [fact(wider)])).toEqual([
      "the fact 'notes.created' changed the schema of shape 1 without a new shape",
    ]);
  });

  test('a narrower bound and a value more in an enum at the same shape are said too', () => {
    const bound = Type.Object({ id: Type.String({ maxLength: 10 }) });
    expect(factIncompatibilities(released, [fact(bound)])).toHaveLength(1);
    const before = [releasedFactFrom(fact(Type.Object({ kind: Type.Union([Type.Literal('a')]) })))];
    const after = fact(Type.Object({ kind: Type.Union([Type.Literal('a'), Type.Literal('b')]) }));
    expect(factIncompatibilities(before, [after])).toHaveLength(1);
  });

  test('the same schema written with its keys in another order is the same schema', () => {
    const reordered = Type.Object({ b: Type.String(), a: Type.String() });
    const first = Type.Object({ a: Type.String(), b: Type.String() });
    expect(factIncompatibilities([releasedFactFrom(fact(first))], [fact(reordered)])).toEqual([]);
  });

  test('a new shape that keeps the old schema as its reader is not a break', () => {
    const wider = Type.Object({ id: Type.String(), folder: Type.String() });
    expect(factIncompatibilities(released, [fact(wider, 2, written)])).toEqual([]);
  });

  test('a reader that no longer accepts what the release wrote is said', () => {
    const wider = Type.Object({ id: Type.String(), folder: Type.String() });
    const changed = Type.Object({ id: Type.String(), folder: Type.String() });
    expect(factIncompatibilities(released, [fact(wider, 2, changed)])).toEqual([
      "the fact 'notes.created' changed what its reader of shape 1 accepts",
    ]);
  });

  test('a snapshot written before schemas were kept promised none', () => {
    const { type, shape, reads } = releasedFactFrom(fact(written));
    const wider = Type.Object({ id: Type.String(), folder: Type.String() });
    expect(factIncompatibilities([{ type, shape, reads }], [fact(wider)])).toEqual([]);
  });
});

describe('exceptions', () => {
  const change = "module 'issues' no longer provides 'issues.link'";
  const snapshot = (exceptions: ReleasedSnapshot['exceptions']): ReleasedSnapshot => ({
    manifests: before,
    exceptions,
  });

  test('an unexcused break says how to excuse it', () => {
    const said = unexcused([change], snapshot([]));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"exceptions"');
  });

  test('a dated exception for exactly that break excuses it', () => {
    const excused = snapshot([{ change, on: '2026-11-03', reason: 'replaced by issues.links' }]);
    expect(unexcused([change], excused)).toEqual([]);
  });

  test('an exception for a break that is not there is itself refused', () => {
    const stale = snapshot([{ change, on: '2026-11-03', reason: 'replaced' }]);
    expect(unexcused([], stale)).toEqual([
      `the exception "${change}" excuses nothing now: remove it`,
    ]);
  });
});
