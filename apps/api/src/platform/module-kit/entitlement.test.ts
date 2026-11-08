import { describe, expect, test } from 'bun:test';
import {
  effectiveModules,
  type EffectiveModulesInput,
  type EntitlementCandidate,
  type EntitlementRow,
} from './entitlement';

const NOW = new Date('2026-11-07T12:00:00Z');
const HOUR_MS = 3_600_000;

const chat: EntitlementCandidate = { id: 'chat', requires: [], entitlement: 'always' };
const issues: EntitlementCandidate = { id: 'issues', requires: [] };
const tasks: EntitlementCandidate = { id: 'tasks', requires: ['issues'], entitlement: 'grant' };
const running = [chat, issues, tasks];

const row = (
  module: string,
  state: 'on' | 'off',
  validUntil: Date | null = null,
): EntitlementRow => ({ module, state, validUntil });

const effective = (input: Partial<EffectiveModulesInput>): string[] =>
  [...effectiveModules({ running, rows: [], mode: 'open', now: NOW, ...input })].sort();

describe('the modules a workspace may use', () => {
  test('in open mode a workspace with no row has every module the process runs', () => {
    expect(effective({})).toEqual(['chat', 'issues', 'tasks']);
  });

  test('in managed mode a workspace with no row has only what is not a grant', () => {
    expect(effective({ mode: 'managed' })).toEqual(['chat']);
  });

  test('an off row closes a module in open mode and an on row opens one in managed mode', () => {
    expect(effective({ rows: [row('issues', 'off')] })).toEqual(['chat']);
    expect(effective({ mode: 'managed', rows: [row('issues', 'on')] })).toEqual(['chat', 'issues']);
  });

  test('no row, however it is written, takes away what a module declares always', () => {
    expect(effective({ mode: 'managed', rows: [row('chat', 'off')] })).toEqual(['chat']);
    expect(effective({ rows: [row('chat', 'off')] })).toEqual(['chat', 'issues', 'tasks']);
  });

  test('a module whose requirement is not granted is not either, and the loss follows the chain', () => {
    expect(effective({ mode: 'managed', rows: [row('tasks', 'on')] })).toEqual(['chat']);
    expect(effective({ rows: [row('issues', 'off')] })).toEqual(['chat']);
    const chain = [
      { id: 'a', requires: [] },
      { id: 'b', requires: ['a'] },
      { id: 'c', requires: ['b'] },
    ];
    expect(
      effective({ running: chain, mode: 'managed', rows: [row('b', 'on'), row('c', 'on')] }),
    ).toEqual([]);
    expect(effective({ running: chain, rows: [row('a', 'off')] })).toEqual([]);
  });

  test('a requirement that is not run takes its dependant out', () => {
    expect(effective({ running: [tasks] })).toEqual([]);
  });

  test('a row that has run out is read as no row', () => {
    const lapsed = new Date(NOW.getTime() - HOUR_MS);
    expect(effective({ rows: [row('issues', 'off', lapsed)] })).toEqual([
      'chat',
      'issues',
      'tasks',
    ]);
    expect(effective({ mode: 'managed', rows: [row('issues', 'on', lapsed)] })).toEqual(['chat']);
  });

  test('a row is valid up to the instant it names and not at it', () => {
    const later = new Date(NOW.getTime() + 1);
    expect(effective({ mode: 'managed', rows: [row('issues', 'on', later)] })).toEqual([
      'chat',
      'issues',
    ]);
    expect(effective({ mode: 'managed', rows: [row('issues', 'on', NOW)] })).toEqual(['chat']);
  });

  test('a row for a module the process does not run adds nothing', () => {
    expect(effective({ mode: 'managed', rows: [row('mail', 'on')] })).toEqual(['chat']);
  });

  test('the refusal wins if a module is handed two rows', () => {
    expect(
      effective({ mode: 'managed', rows: [row('issues', 'on'), row('issues', 'off')] }),
    ).toEqual(['chat']);
  });

  test('the set is the same however the rows and the modules are ordered, and asking again changes nothing', () => {
    const rows = [row('issues', 'on'), row('tasks', 'on')];
    const forward = effective({ mode: 'managed', rows });
    expect(effective({ mode: 'managed', rows: [...rows].reverse() })).toEqual(forward);
    expect(effective({ mode: 'managed', rows, running: [...running].reverse() })).toEqual(forward);
    const again = effectiveModules({
      running: running.filter((m) => forward.includes(m.id)),
      rows,
      mode: 'managed',
      now: NOW,
    });
    expect([...again].sort()).toEqual(forward);
  });

  test('no process runs nothing for a workspace in either mode', () => {
    expect(effective({ running: [] })).toEqual([]);
    expect(effective({ running: [], mode: 'managed', rows: [row('issues', 'on')] })).toEqual([]);
  });
});

describe('the modules the administrator has stopped (D-296)', () => {
  const stopped = (...ids: string[]): ReadonlySet<string> => new Set(ids);

  test('leave every workspace’s set, whatever it is granted and in either mode', () => {
    expect(effective({ suspended: stopped('issues') })).toEqual(['chat']);
    expect(
      effective({ mode: 'managed', rows: [row('issues', 'on')], suspended: stopped('issues') }),
    ).toEqual(['chat']);
  });

  test('take with them the modules that require them, and give them back together', () => {
    expect(effective({ suspended: stopped('issues') })).not.toContain('tasks');
    expect(effective({ suspended: stopped() })).toEqual(['chat', 'issues', 'tasks']);
  });

  test('do not spare a module that is always granted, which is why stopping one asks to be confirmed', () => {
    expect(effective({ suspended: stopped('chat') })).toEqual(['issues', 'tasks']);
  });

  test('are a stop and nothing else: a name no process runs changes nothing, and an empty stop changes nothing', () => {
    expect(effective({ suspended: stopped('mail') })).toEqual(['chat', 'issues', 'tasks']);
    expect(effective({ suspended: stopped() })).toEqual(effective({}));
  });
});
