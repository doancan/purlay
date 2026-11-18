/**
 * What the project board shows and what a claim may do, as pure rules.
 *
 * Status is derived rather than kept by hand (CONTRIBUTING §7): an issue is in
 * review when an open pull request closes it, in progress when somebody holds
 * it, backlog while something it waits on is open, ready otherwise. Nothing here
 * reads GitHub or the clock; `board-github.ts` fetches, callers pass `now`.
 */
export type Stage = 'Backlog' | 'Ready' | 'In progress' | 'In review';

export interface BoardIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'OPEN' | 'CLOSED';
  readonly milestone: string | null;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  /** Numbers of the open pull requests whose body closes this issue. */
  readonly closingPullRequests: readonly number[];
  readonly updatedAt: string;
}

export type Refusal = { readonly reason: string } | null;

/**
 * The labels that say which part of the code an issue touches. `infra`, `docs`,
 * `testing` and `security` cut across all of them, so two issues sharing one say
 * nothing about touching the same files.
 */
export const AREA_LABELS: readonly string[] = ['api', 'web', 'database', 'realtime', 'contracts'];

const EXCLUSIVE_LABEL = 'exclusive';
const ONE_AT_A_TIME_LABEL = 'database';
const DAY_MS = 86_400_000;

export const isEpic = (issue: BoardIssue): boolean => issue.body.startsWith('> **Epic**');

/** `> **Blocked by** #4 · #12` — one line in the issue body, next to the work. */
export const blockersOf = (issue: BoardIssue): number[] => {
  const line = /\*\*Blocked by\*\*(.+)/.exec(issue.body)?.[1] ?? '';
  return [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
};

type World = ReadonlyMap<number, BoardIssue>;

/** A blocker missing from the list is treated as open: refusing is the safe error. */
const openBlockers = (issue: BoardIssue, all: World): number[] =>
  blockersOf(issue).filter((n) => all.get(n)?.state !== 'CLOSED');

export const stageOf = (issue: BoardIssue, all: World): Stage => {
  if (issue.closingPullRequests.length > 0) return 'In review';
  if (issue.assignees.length > 0) return 'In progress';
  if (openBlockers(issue, all).length > 0) return 'Backlog';
  return 'Ready';
};

const areasOf = (issue: BoardIssue): string[] =>
  issue.labels.filter((label) => AREA_LABELS.includes(label));

const hasLabel = (issue: BoardIssue, label: string): boolean => issue.labels.includes(label);

const underWay = (issue: BoardIssue, all: World): boolean =>
  issue.state === 'OPEN' && ['In progress', 'In review'].includes(stageOf(issue, all));

const sharesArea = (a: BoardIssue, b: BoardIssue): boolean =>
  areasOf(a).some((area) => areasOf(b).includes(area));

/** Issues already under way that touch the same part of the code as this one. */
export const sameAreaInProgress = (issue: BoardIssue, all: World): BoardIssue[] =>
  [...all.values()].filter(
    (other) => other.number !== issue.number && underWay(other, all) && sharesArea(issue, other),
  );

const refusal = (reason: string): Refusal => ({ reason });

/** Why `me` may not start this issue now, or null. The first reason that applies. */
export const claimRefusal = (issue: BoardIssue, all: World, me: string): Refusal => {
  if (issue.state === 'CLOSED') return refusal(`#${String(issue.number)} is closed`);
  if (isEpic(issue))
    return refusal(`#${String(issue.number)} is an epic; claim one of its children`);
  const others = issue.assignees.filter((login) => login !== me);
  if (others.length > 0) {
    return refusal(
      `#${String(issue.number)} is already held by ${others.map((o) => `@${o}`).join(', ')}`,
    );
  }
  if (issue.assignees.includes(me)) return null;
  const [pullRequest] = issue.closingPullRequests;
  if (pullRequest !== undefined) {
    return refusal(`#${String(issue.number)} already has pull request #${String(pullRequest)}`);
  }

  const blockers = openBlockers(issue, all);
  if (blockers.length > 0) {
    return refusal(
      `#${String(issue.number)} waits on ${blockers.map((n) => `#${String(n)}`).join(', ')}`,
    );
  }

  const neighbours = sameAreaInProgress(issue, all);
  if (hasLabel(issue, ONE_AT_A_TIME_LABEL)) {
    const running = neighbours.find((other) => hasLabel(other, ONE_AT_A_TIME_LABEL));
    if (running) {
      return refusal(
        `#${String(running.number)} is already changing the database; migrations are numbered, so one at a time`,
      );
    }
  }
  if (hasLabel(issue, EXCLUSIVE_LABEL) && neighbours.length > 0) {
    const [running] = neighbours;
    return refusal(
      `#${String(issue.number)} is exclusive and #${String(running?.number)} is under way in the same area`,
    );
  }
  const holder = neighbours.find((other) => hasLabel(other, EXCLUSIVE_LABEL));
  if (holder) {
    return refusal(`#${String(holder.number)} is exclusive and under way in the same area`);
  }
  return null;
};

export const idleDays = (issue: BoardIssue, now: Date): number =>
  Math.floor((now.getTime() - new Date(issue.updatedAt).getTime()) / DAY_MS);
