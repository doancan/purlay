import { describe, expect, test } from 'bun:test';
import {
  blockersOf,
  claimRefusal,
  idleDays,
  isEpic,
  sameAreaInProgress,
  stageOf,
  type BoardIssue,
} from './board-rules';

const issue = (over: Partial<BoardIssue> & { number: number }): BoardIssue => ({
  title: `issue ${String(over.number)}`,
  body: '',
  state: 'OPEN',
  milestone: null,
  labels: [],
  assignees: [],
  closingPullRequests: [],
  updatedAt: '2026-11-18T00:00:00Z',
  ...over,
});

const world = (...issues: BoardIssue[]): ReadonlyMap<number, BoardIssue> =>
  new Map(issues.map((i) => [i.number, i]));

describe('blockersOf', () => {
  test('reads every number on the Blocked by line', () => {
    expect(blockersOf(issue({ number: 1, body: '> **Blocked by** #4 · #12\nmore' }))).toEqual([
      4, 12,
    ]);
  });
  test('is empty without the line', () => {
    expect(blockersOf(issue({ number: 1, body: 'see #4' }))).toEqual([]);
  });
});

describe('isEpic', () => {
  test('is an issue whose body starts with the epic banner', () => {
    expect(isEpic(issue({ number: 1, body: '> **Epic** · Ships in `v1.0.0`' }))).toBe(true);
    expect(isEpic(issue({ number: 2, body: 'not an > **Epic**' }))).toBe(false);
  });
});

describe('stageOf', () => {
  const blocker = issue({ number: 9 });
  const closedBlocker = issue({ number: 9, state: 'CLOSED' });
  const blockedBody = '> **Blocked by** #9';

  test('an open pull request that closes it is In review, even assigned and blocked', () => {
    const i = issue({
      number: 1,
      body: blockedBody,
      assignees: ['a'],
      closingPullRequests: [50],
    });
    expect(stageOf(i, world(i, blocker))).toBe('In review');
  });
  test('an assignee makes it In progress, even when blocked', () => {
    const i = issue({ number: 1, body: blockedBody, assignees: ['a'] });
    expect(stageOf(i, world(i, blocker))).toBe('In progress');
  });
  test('an open blocker makes it Backlog', () => {
    const i = issue({ number: 1, body: blockedBody });
    expect(stageOf(i, world(i, blocker))).toBe('Backlog');
  });
  test('a closed blocker no longer blocks', () => {
    const i = issue({ number: 1, body: blockedBody });
    expect(stageOf(i, world(i, closedBlocker))).toBe('Ready');
  });
  test('an issue with no blocker is Ready', () => {
    const i = issue({ number: 1 });
    expect(stageOf(i, world(i))).toBe('Ready');
  });
  test('a blocker that is not in the list counts as open', () => {
    const i = issue({ number: 1, body: blockedBody });
    expect(stageOf(i, world(i))).toBe('Backlog');
  });
});

describe('claimRefusal', () => {
  test('a free issue may be claimed', () => {
    const i = issue({ number: 1, labels: ['api'] });
    expect(claimRefusal(i, world(i), 'me')).toBeNull();
  });
  test('an issue already held by me is accepted again', () => {
    const i = issue({ number: 1, assignees: ['me'] });
    expect(claimRefusal(i, world(i), 'me')).toBeNull();
  });
  test('a closed issue is refused', () => {
    const i = issue({ number: 1, state: 'CLOSED' });
    expect(claimRefusal(i, world(i), 'me')?.reason).toContain('closed');
  });
  test('an epic is refused', () => {
    const i = issue({ number: 1, body: '> **Epic** · x' });
    expect(claimRefusal(i, world(i), 'me')?.reason).toContain('epic');
  });
  test('an issue held by someone else is refused and names them', () => {
    const i = issue({ number: 1, assignees: ['gorke'] });
    expect(claimRefusal(i, world(i), 'me')?.reason).toContain('gorke');
  });
  test('an issue an open pull request already closes is refused and names the pull request', () => {
    const i = issue({ number: 1, closingPullRequests: [77] });
    expect(claimRefusal(i, world(i), 'me')?.reason).toContain('#77');
  });
  test('an issue blocked by an open issue is refused and names it', () => {
    const i = issue({ number: 1, body: '> **Blocked by** #9' });
    expect(claimRefusal(i, world(i, issue({ number: 9 })), 'me')?.reason).toContain('#9');
  });
  test('a second database issue is refused while one is in progress', () => {
    const running = issue({ number: 2, labels: ['database'], assignees: ['gorke'] });
    const i = issue({ number: 1, labels: ['database', 'api'] });
    expect(claimRefusal(i, world(i, running), 'me')?.reason).toContain('#2');
  });
  test('a database issue is free while another database issue is only Ready', () => {
    const waiting = issue({ number: 2, labels: ['database'] });
    const i = issue({ number: 1, labels: ['database'] });
    expect(claimRefusal(i, world(i, waiting), 'me')).toBeNull();
  });
  test('an exclusive issue is refused while another issue in its area is in progress', () => {
    const running = issue({ number: 2, labels: ['web'], assignees: ['gorke'] });
    const i = issue({ number: 1, labels: ['exclusive', 'web'] });
    expect(claimRefusal(i, world(i, running), 'me')?.reason).toContain('#2');
  });
  test('an exclusive issue is not stopped by work in another area', () => {
    const running = issue({ number: 2, labels: ['api'], assignees: ['gorke'] });
    const i = issue({ number: 1, labels: ['exclusive', 'web'] });
    expect(claimRefusal(i, world(i, running), 'me')).toBeNull();
  });
  test('any issue is refused while an exclusive issue in its area is in progress', () => {
    const running = issue({ number: 2, labels: ['exclusive', 'web'], assignees: ['gorke'] });
    const i = issue({ number: 1, labels: ['web'] });
    expect(claimRefusal(i, world(i, running), 'me')?.reason).toContain('#2');
  });
  test('an exclusive issue held by me still keeps my other work in its area waiting', () => {
    const mine = issue({ number: 2, labels: ['exclusive', 'web'], assignees: ['me'] });
    const i = issue({ number: 1, labels: ['web'] });
    expect(claimRefusal(i, world(i, mine), 'me')?.reason).toContain('#2');
  });
  test('a cross-cutting label such as testing is not an area', () => {
    const running = issue({ number: 2, labels: ['exclusive', 'web', 'testing'], assignees: ['x'] });
    const i = issue({ number: 1, labels: ['testing'] });
    expect(claimRefusal(i, world(i, running), 'me')).toBeNull();
  });
});

describe('sameAreaInProgress', () => {
  test('lists only in-progress issues that share an area label, not itself', () => {
    const self = issue({ number: 1, labels: ['api'], assignees: ['me'] });
    const same = issue({ number: 2, labels: ['api', 'testing'], assignees: ['gorke'] });
    const other = issue({ number: 3, labels: ['web'], assignees: ['gorke'] });
    const idle = issue({ number: 4, labels: ['api'] });
    expect(sameAreaInProgress(self, world(self, same, other, idle)).map((i) => i.number)).toEqual([
      2,
    ]);
  });
  test('a label that is not an area does not make two issues neighbours', () => {
    const self = issue({ number: 1, labels: ['enhancement'] });
    const other = issue({ number: 2, labels: ['enhancement'], assignees: ['gorke'] });
    expect(sameAreaInProgress(self, world(self, other))).toEqual([]);
  });
});

describe('idleDays', () => {
  test('counts whole days since the last update', () => {
    const i = issue({ number: 1, updatedAt: '2026-11-01T12:00:00Z' });
    expect(idleDays(i, new Date('2026-11-18T11:59:00Z'))).toBe(16);
  });
});
