import { describe, expect, test } from 'bun:test';
import type { BoardIssue } from './board-rules';
import { branchHint, claim, release, type ClaimPorts, type ClaimResult } from './claim-run';

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

const reasonOf = (result: ClaimResult): string => (result.ok ? '' : result.reason);
const noticesOf = (result: ClaimResult): string[] => (result.ok ? result.notices : []);

type FakePorts = ClaimPorts & { readonly calls: string[] };

/**
 * Fake ports over a list of issues. `meanwhile` runs right after my assignment lands and may
 * change the assignees: it plays what another person's claim did in between.
 */
const fake = (
  issues: BoardIssue[],
  meanwhile?: (current: readonly string[]) => string[],
): FakePorts => {
  const calls: string[] = [];
  const read = (n: number): BoardIssue => {
    const found = issues.find((i) => i.number === n);
    if (found === undefined) throw new Error(`no issue ${String(n)}`);
    return found;
  };
  const write = (n: number, assignees: readonly string[]): void => {
    issues.splice(issues.indexOf(read(n)), 1, { ...read(n), assignees });
  };
  return {
    calls,
    me: 'me',
    all: () => new Map(issues.map((i) => [i.number, i])),
    one: read,
    assign: (n, user): void => {
      calls.push(`assign ${String(n)} ${user}`);
      write(n, [...read(n).assignees, user]);
      if (meanwhile) write(n, meanwhile(read(n).assignees));
    },
    unassign: (n, user): void => {
      calls.push(`unassign ${String(n)} ${user}`);
      write(
        n,
        read(n).assignees.filter((a) => a !== user),
      );
    },
  };
};

describe('claim', () => {
  test('assigns a free issue to me and names the work already under way beside it', () => {
    const p = fake([
      issue({ number: 1, labels: ['api'] }),
      issue({ number: 2, labels: ['api'], assignees: ['gorke'] }),
    ]);
    const result = claim(1, p);
    expect(result.ok).toBe(true);
    expect(p.calls).toEqual(['assign 1 me']);
    expect(noticesOf(result).join('\n')).toContain('#2');
  });

  test('a refusal assigns nothing', () => {
    const p = fake([issue({ number: 1, assignees: ['gorke'] })]);
    const result = claim(1, p);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('@gorke');
    expect(p.calls).toEqual([]);
  });

  test('claiming what I already hold changes nothing', () => {
    const p = fake([issue({ number: 1, assignees: ['me'] })]);
    expect(claim(1, p).ok).toBe(true);
    expect(p.calls).toEqual([]);
  });

  test('a blocker closed since the list was read no longer refuses', () => {
    const p = fake([
      issue({ number: 1, body: '> **Blocked by** #9' }),
      issue({ number: 9, state: 'CLOSED' }),
    ]);
    // The list the script holds is stale: it still shows #9 open. `one` is the fresh read.
    const stale: ClaimPorts = {
      ...p,
      all: () =>
        new Map([
          [1, p.one(1)],
          [9, issue({ number: 9 })],
        ]),
    };
    expect(claim(1, stale).ok).toBe(true);
  });

  test('a blocker that is still open refuses', () => {
    const p = fake([issue({ number: 1, body: '> **Blocked by** #9' }), issue({ number: 9 })]);
    expect(reasonOf(claim(1, p))).toContain('#9');
  });

  test('when somebody else was assigned first, I back off and leave nothing of mine', () => {
    const p = fake([issue({ number: 1 })], () => ['gorke', 'me']);
    const result = claim(1, p);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('@gorke');
    expect(p.calls).toEqual(['assign 1 me', 'unassign 1 me']);
    expect(p.one(1).assignees).toEqual(['gorke']);
  });

  test('when somebody else is assigned beside me, I back off even if I am listed first', () => {
    // GitHub's listing order is not the order of assignment, so "first" proves nothing.
    const p = fake([issue({ number: 1 })], () => ['me', 'gorke']);
    const result = claim(1, p);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('@gorke');
    expect(p.calls).toEqual(['assign 1 me', 'unassign 1 me']);
  });

  test('when the assignment did not take, the claim is not reported as mine', () => {
    const p = fake([issue({ number: 1 })], () => []);
    const result = claim(1, p);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('did not take');
  });
});

describe('release', () => {
  test('unassigns my own claim', () => {
    const p = fake([issue({ number: 1, assignees: ['me'] })]);
    expect(release(1, p).ok).toBe(true);
    expect(p.calls).toEqual(['unassign 1 me']);
  });
  test("refuses to release somebody else's claim", () => {
    const p = fake([issue({ number: 1, assignees: ['gorke'] })]);
    const result = release(1, p);
    expect(result.ok).toBe(false);
    expect(reasonOf(result)).toContain('@gorke');
    expect(p.calls).toEqual([]);
  });
  test('refuses an issue nobody holds', () => {
    const p = fake([issue({ number: 1 })]);
    expect(release(1, p).ok).toBe(false);
  });
});

describe('branchHint', () => {
  const hint = (title: string, labels: string[]): string =>
    branchHint(issue({ number: 1, title, labels }));

  test('a bug is fix/', () => {
    expect(hint('Fix the crash', ['bug', 'api'])).toBe('fix/fix-the-crash');
  });
  test('documentation alone is docs/', () => {
    expect(hint('Document native Postgres', ['docs'])).toBe('docs/document-native-postgres');
  });
  test('infra alone is chore/', () => {
    expect(hint('Add tracing', ['infra'])).toBe('chore/add-tracing');
  });
  test('anything else is feat/', () => {
    expect(hint('Add the CLI twin', ['enhancement', 'api'])).toBe('feat/add-the-cli-twin');
  });
  test('the slug is lowercase ASCII of at most 40 characters and carries no issue number', () => {
    const result = hint(
      'Çok uzun bir başlık: "Cap each search source\'s hits" (#1301) and more',
      [],
    );
    expect(result).toMatch(/^feat\/[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(result.slice('feat/'.length).length).toBeLessThanOrEqual(40);
    expect(result).not.toContain('1301');
    expect(result.startsWith('feat/cok-uzun-bir-baslik')).toBe(true);
  });
});
