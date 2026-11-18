/**
 * Taking an issue, and giving it back, over ports so the rules can be tested
 * without GitHub. `claim.ts` wires the real ones.
 *
 * GitHub has no compare-and-set on assignees, so two people claiming in the same
 * second can both be assigned. The claim therefore reads the issue again after
 * assigning: the assignee GitHub lists first holds it, the other backs off.
 */
import {
  AREA_LABELS,
  blockersOf,
  claimRefusal,
  sameAreaInProgress,
  type BoardIssue,
} from './board-rules';

export interface ClaimPorts {
  readonly me: string;
  readonly all: () => ReadonlyMap<number, BoardIssue>;
  /** A fresh read of one issue. */
  readonly one: (number: number) => BoardIssue;
  readonly assign: (number: number, user: string) => void;
  readonly unassign: (number: number, user: string) => void;
}

export type ClaimResult =
  | { readonly ok: true; readonly notices: string[] }
  | { readonly ok: false; readonly reason: string };

const SLUG_MAX = 40;

const fail = (reason: string): ClaimResult => ({ ok: false, reason });

/** The list the script holds, with the issue and its still-open blockers read again. */
const freshWorld = (
  number: number,
  ports: ClaimPorts,
): { issue: BoardIssue; world: Map<number, BoardIssue> } => {
  const world = new Map(ports.all());
  const issue = ports.one(number);
  world.set(number, issue);
  for (const blocker of blockersOf(issue)) {
    if (world.get(blocker)?.state !== 'CLOSED') world.set(blocker, ports.one(blocker));
  }
  return { issue, world };
};

export const claim = (number: number, ports: ClaimPorts): ClaimResult => {
  const { issue, world } = freshWorld(number, ports);
  const refusal = claimRefusal(issue, world, ports.me);
  if (refusal) return fail(refusal.reason);

  const notices = sameAreaInProgress(issue, world).map(
    (other) =>
      `#${String(other.number)} is under way in the same area (${other.assignees.map((a) => `@${a}`).join(' ')})`,
  );
  if (issue.assignees.includes(ports.me)) return { ok: true, notices };

  ports.assign(number, ports.me);
  const [first, ...rest] = ports.one(number).assignees;
  if (first !== ports.me && [first, ...rest].includes(ports.me)) {
    ports.unassign(number, ports.me);
    return fail(`#${String(number)} was taken a moment earlier by @${String(first)}`);
  }
  return { ok: true, notices };
};

export const release = (number: number, ports: ClaimPorts): ClaimResult => {
  const { assignees } = ports.one(number);
  if (assignees.includes(ports.me)) {
    ports.unassign(number, ports.me);
    return { ok: true, notices: [] };
  }
  if (assignees.length === 0) return fail(`#${String(number)} is not held by anyone`);
  return fail(
    `#${String(number)} is held by ${assignees.map((a) => `@${a}`).join(' ')}, not by you`,
  );
};

const slugOf = (title: string): string =>
  title
    .replace(/#\d+/g, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');

/** `feat/…`, `fix/…`, `docs/…` or `chore/…`, in the vocabulary of `check:branch` (no issue number). */
export const branchHint = (issue: BoardIssue): string => {
  const touchesCode = issue.labels.some((label) => AREA_LABELS.includes(label));
  const type = issue.labels.includes('bug')
    ? 'fix'
    : !touchesCode && issue.labels.includes('docs')
      ? 'docs'
      : !touchesCode && issue.labels.includes('infra')
        ? 'chore'
        : 'feat';
  return `${type}/${slugOf(issue.title)}`;
};
