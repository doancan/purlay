/**
 * The queue's text, and the stage of every issue it writes to the board.
 *
 * Pure: `queue.ts` fetches, prints this and applies it.
 */
import { blockersOf, idleDays, isEpic, stageOf, type BoardIssue, type Stage } from './board-rules';

/** A claim nobody has touched for this long is flagged: it may be abandoned, not just slow. */
const IDLE_FLAG_DAYS = 14;

const open = (issues: readonly BoardIssue[]): BoardIssue[] =>
  issues.filter((i) => i.state === 'OPEN' && !isEpic(i));

const world = (issues: readonly BoardIssue[]): ReadonlyMap<number, BoardIssue> =>
  new Map(issues.map((i) => [i.number, i]));

/** Issue number → the stage the board should show, for every open issue that is not an epic. */
export const stagesFor = (issues: readonly BoardIssue[]): Map<number, Stage> => {
  const all = world(issues);
  return new Map(open(issues).map((i) => [i.number, stageOf(i, all)]));
};

/** The lowest version that still has open work. Milestones are versions (D-32). */
const currentMilestone = (issues: readonly BoardIssue[]): string => {
  const titles = [
    ...new Set(open(issues).flatMap((i) => (i.milestone === null ? [] : [i.milestone]))),
  ];
  titles.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return titles[0] ?? '';
};

const head = (i: BoardIssue): string => `  #${String(i.number).padEnd(4)} ${i.title}`;
const labelsOf = (i: BoardIssue): string => i.labels.join(' ');

const section = (title: string, rows: readonly string[]): string[] =>
  rows.length === 0 ? [] : ['', `${title} (${String(rows.length / 2)})`, ...rows];

export const render = (issues: readonly BoardIssue[], now: Date): string => {
  const all = world(issues);
  const mine = open(issues).sort((a, b) => a.number - b.number);
  const milestone = currentMilestone(issues);
  const stage = (s: Stage, keep: (i: BoardIssue) => boolean = () => true): BoardIssue[] =>
    mine.filter((i) => stageOf(i, all) === s && keep(i));

  const inReview = stage('In review').flatMap((i) => [
    head(i),
    `        ${i.closingPullRequests.map((n) => `PR #${String(n)}`).join(' ')} · ${labelsOf(i)}`,
  ]);
  const inProgress = stage('In progress').flatMap((i) => {
    const idle = idleDays(i, now);
    const age = idle >= IDLE_FLAG_DAYS ? `${String(idle)}d idle` : `${String(idle)}d`;
    return [
      head(i),
      `        ${i.assignees.map((a) => `@${a}`).join(' ')} · ${labelsOf(i)} · ${age}`,
    ];
  });
  const ready = (title: string, keep: (i: BoardIssue) => boolean): string[] =>
    section(
      title,
      stage('Ready', keep).flatMap((i) => [head(i), `        ${labelsOf(i)}`]),
    );
  const blocked = (title: string, keep: (i: BoardIssue) => boolean): string[] =>
    section(
      title,
      stage('Backlog', keep).flatMap((i) => [
        head(i),
        `        waiting on ${blockersOf(i)
          .filter((n) => all.get(n)?.state !== 'CLOSED')
          .map((n) => `#${String(n)}`)
          .join(', ')}`,
      ]),
    );

  const inCurrent = (i: BoardIssue): boolean => i.milestone === milestone;
  const unscheduled = (i: BoardIssue): boolean => i.milestone === null;

  return [
    `\nMilestone ${milestone === '' ? '(none)' : milestone} — ${String(mine.length)} open`,
    ...section('IN REVIEW', inReview),
    ...section('IN PROGRESS', inProgress),
    ...ready(`READY IN ${milestone}`, inCurrent),
    ...blocked(`BLOCKED IN ${milestone}`, inCurrent),
    ...ready('UNSCHEDULED READY', unscheduled),
    ...blocked('UNSCHEDULED BLOCKED', unscheduled),
    '',
  ].join('\n');
};
