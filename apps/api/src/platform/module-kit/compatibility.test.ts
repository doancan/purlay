import { describe, expect, test } from 'bun:test';
import { incompatibilities, releasedFrom, unexcused, type ReleasedSnapshot } from './compatibility';
import type { ModuleManifest } from './manifest';

const manifest = (overrides: Partial<ModuleManifest> & { id: string }): ModuleManifest => ({
  requires: [],
  optional: [],
  provides: [],
  ...overrides,
});

const unchanged = manifest({
  id: 'issues',
  optional: ['chat'],
  provides: ['issues.link'],
  routes: ['/api/issues/**'],
  jobs: ['issues:remind'],
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

  test('a capability, a route and a job that went are each said', () => {
    const now = manifest({ id: 'issues', optional: ['chat'] });
    expect(incompatibilities(before, [now])).toEqual([
      "module 'issues' no longer provides 'issues.link'",
      "module 'issues' no longer owns the route '/api/issues/**'",
      "module 'issues' no longer runs the job 'issues:remind'",
    ]);
  });

  test('a module that is gone, or whose id changed, is said', () => {
    expect(incompatibilities(before, [manifest({ id: 'tickets' })])).toEqual([
      "module 'issues' is no longer in the build, or its id changed: operators name it in MODULES",
    ]);
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
