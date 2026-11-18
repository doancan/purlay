import { describe, expect, test } from 'bun:test';
import type { BoardIssue } from './board-rules';
import { render, stagesFor } from './queue-render';

const issue = (over: Partial<BoardIssue> & { number: number }): BoardIssue => ({
  title: `title ${String(over.number)}`,
  body: '',
  state: 'OPEN',
  milestone: null,
  labels: [],
  assignees: [],
  closingPullRequests: [],
  updatedAt: '2026-11-18T00:00:00Z',
  ...over,
});

const NOW = new Date('2026-11-18T12:00:00Z');

describe('stagesFor', () => {
  test('stages every open issue except epics and closed ones', () => {
    const stages = stagesFor([
      issue({ number: 1 }),
      issue({ number: 2, assignees: ['a'] }),
      issue({ number: 3, closingPullRequests: [9] }),
      issue({ number: 4, body: '> **Blocked by** #1' }),
      issue({ number: 5, body: '> **Epic** · x' }),
      issue({ number: 6, state: 'CLOSED' }),
    ]);
    expect([...stages]).toEqual([
      [1, 'Ready'],
      [2, 'In progress'],
      [3, 'In review'],
      [4, 'Backlog'],
    ]);
  });
});

describe('render', () => {
  test('lists an issue in progress with who, where and how long it has been idle', () => {
    const text = render(
      [
        issue({
          number: 7,
          assignees: ['doancan'],
          labels: ['api', 'database'],
          updatedAt: '2026-11-15T12:00:00Z',
        }),
      ],
      NOW,
    );
    expect(text).toContain('IN PROGRESS (1)');
    expect(text).toContain('#7');
    expect(text).toContain('@doancan');
    expect(text).toContain('api database');
    expect(text).toContain('3d');
    expect(text).not.toContain('idle');
  });

  test('flags an issue in progress that has been quiet for 14 days', () => {
    const text = render(
      [issue({ number: 7, assignees: ['a'], updatedAt: '2026-11-04T12:00:00Z' })],
      NOW,
    );
    expect(text).toContain('14d idle');
  });

  test('names the pull request of an issue in review', () => {
    const text = render([issue({ number: 8, closingPullRequests: [41] })], NOW);
    expect(text).toContain('IN REVIEW (1)');
    expect(text).toContain('PR #41');
  });

  test('shows open issues with no milestone as unscheduled, ready and blocked apart', () => {
    const text = render(
      [issue({ number: 1 }), issue({ number: 2, body: '> **Blocked by** #1' })],
      NOW,
    );
    expect(text).toContain('UNSCHEDULED READY (1)');
    expect(text).toContain('UNSCHEDULED BLOCKED (1)');
    expect(text).toContain('waiting on #1');
  });

  test('puts the lowest open milestone first and calls it current', () => {
    const text = render(
      [issue({ number: 1, milestone: 'v0.10.0' }), issue({ number: 2, milestone: 'v0.4.0' })],
      NOW,
    );
    expect(text).toContain('Milestone v0.4.0');
    expect(text).toContain('READY IN v0.4.0 (1)');
    expect(text).not.toContain('#1 ');
  });

  test('leaves out epics and closed issues', () => {
    const text = render(
      [issue({ number: 5, body: '> **Epic** · x' }), issue({ number: 6, state: 'CLOSED' })],
      NOW,
    );
    expect(text).not.toContain('#5');
    expect(text).not.toContain('#6');
  });
});
