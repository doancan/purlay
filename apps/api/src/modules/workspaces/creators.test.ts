/** How `WORKSPACE_CREATORS` is read (D-155); what each rule lets is the integration test's. */
import { describe, expect, test } from 'bun:test';
import { workspaceCreatorsOf } from './creators';

describe('who may make a workspace, read from the configuration', () => {
  test('unset or empty is the first person on an empty instance', () => {
    expect(workspaceCreatorsOf(undefined)).toEqual({ kind: 'first' });
    expect(workspaceCreatorsOf('  ')).toEqual({ kind: 'first' });
  });

  test('`*` is anybody signed in', () => {
    expect(workspaceCreatorsOf(' * ')).toEqual({ kind: 'anyone' });
  });

  test('a list is logins, trimmed, in lower case', () => {
    expect(workspaceCreatorsOf(' Alice, bob-2 ,CAROL ')).toEqual({
      kind: 'listed',
      logins: new Set(['alice', 'bob-2', 'carol']),
    });
  });
});
