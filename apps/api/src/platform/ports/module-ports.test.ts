/**
 * What a module is handed of the ports it `uses` (D-283 §3) and how it shows a link to another module's record (D-291): the
 * view of one workspace, with `undefined` for a provider that is not run, was stopped or is not granted, and one answer for a
 * record that cannot be shown. The provider that reads a real table is `features/issues/records.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import type { Executor } from '@purlay/db';
import { modulePorts, noPorts, type PortSources } from './module-ports';
import type { RecordResolver, WorkspaceScope } from './record-ref';

const database = {} as Executor;
const WORKSPACE = 'w1';
const everything: WorkspaceScope = { workspaceId: WORKSPACE, modules: null };

const widgets: RecordResolver = {
  resolve: ({ scope, type, id }) =>
    Promise.resolve(
      type === 'widget' && id === 'w-1' && scope.workspaceId === WORKSPACE
        ? { label: 'A widget' }
        : undefined,
    ),
};

const sourcesOf = (overrides: Partial<PortSources> = {}): PortSources => ({
  uses: ['issues.records'],
  providerOf: (capability) => (capability === 'issues.records' ? 'issues' : undefined),
  running: () => ({ 'issues.records': widgets }),
  ...overrides,
});

const issueRef = { module: 'issues', type: 'widget', id: 'w-1' } as const;

describe('the ports of a module', () => {
  test('are those of the capabilities it uses, where the provider runs', () => {
    expect(modulePorts(sourcesOf(), database).of(everything)).toEqual({
      'issues.records': widgets,
    });
  });

  test('are absent where the provider is not run', () => {
    const view = modulePorts(
      sourcesOf({ providerOf: () => undefined, running: () => ({}) }),
      database,
    );
    expect(view.of(everything)).toEqual({});
  });

  test('are absent where the provider is stopped, as the module is when it is read', () => {
    let stopped = false;
    const view = modulePorts(
      sourcesOf({ running: () => (stopped ? {} : { 'issues.records': widgets }) }),
      database,
    );
    expect(view.of(everything)['issues.records']).toBe(widgets);
    stopped = true;
    expect(view.of(everything)['issues.records']).toBeUndefined();
  });

  test('are asked for each workspace: absent where the workspace is not granted the provider', () => {
    const view = modulePorts(sourcesOf(), database);
    const granted = { workspaceId: WORKSPACE, modules: new Set(['tasks', 'issues']) };
    const withheld = { workspaceId: 'w2', modules: new Set(['tasks']) };
    expect(view.of(granted)['issues.records']).toBe(widgets);
    expect(view.of(withheld)['issues.records']).toBeUndefined();
  });

  test('leave out a capability the module does not use, though its provider runs', () => {
    const view = modulePorts(sourcesOf({ uses: [] }), database);
    expect(view.of(everything)).toEqual({});
  });
});

describe('a process without a composition', () => {
  test('has no ports at all', () => {
    expect(noPorts.of(everything)).toEqual({});
  });
});

describe('resolveRef', () => {
  test('answers the live label of a record the workspace has', async () => {
    expect(await modulePorts(sourcesOf(), database).resolveRef(issueRef, everything)).toEqual({
      status: 'available',
      ref: issueRef,
      label: 'A widget',
    });
  });

  test('answers unavailable, the same value, for every reason a record cannot be shown', async () => {
    const view = modulePorts(sourcesOf(), database);
    const notRun = modulePorts(
      sourcesOf({ providerOf: () => undefined, running: () => ({}) }),
      database,
    );
    const answers = await Promise.all([
      notRun.resolveRef(issueRef, everything),
      view.resolveRef(issueRef, { workspaceId: WORKSPACE, modules: new Set(['tasks']) }),
      view.resolveRef({ ...issueRef, id: 'gone' }, everything),
      view.resolveRef(issueRef, { workspaceId: 'other', modules: null }),
      view.resolveRef({ ...issueRef, type: 'unknown' }, everything),
      view.resolveRef({ ...issueRef, module: 'wiki' }, everything),
      modulePorts(sourcesOf({ uses: [] }), database).resolveRef(issueRef, everything),
      noPorts.resolveRef(issueRef, everything),
    ]);
    expect(new Set(answers.map((answer) => JSON.stringify(answer)))).toEqual(
      new Set([JSON.stringify({ status: 'unavailable' })]),
    );
  });

  test('does not hide a failure of the provider’s database as an absent record', async () => {
    const broken: RecordResolver = { resolve: () => Promise.reject(new Error('connection lost')) };
    const view = modulePorts(
      sourcesOf({ running: () => ({ 'issues.records': broken }) }),
      database,
    );
    const failure = await view.resolveRef(issueRef, everything).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toEqual(new Error('connection lost'));
  });
});
