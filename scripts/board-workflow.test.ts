/** The board workflow keeps a token that can write the board: what it runs and when is held here. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const text = readFileSync(join(import.meta.dir, '../.github/workflows/board.yml'), 'utf8');
const lines = text.split('\n');

/** The names directly under a top-level `key:` block, at the given indent. */
const keysUnder = (key: string, indent: number): string[] => {
  const start = lines.findIndex((line) => line === `${key}:`);
  expect(start, `no ${key}:`).toBeGreaterThan(-1);
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const match = new RegExp(`^ {${String(indent)}}([\\w-]+):`).exec(line);
    if (match?.[1] !== undefined) found.push(match[1]);
  }
  return found;
};

describe('board workflow', () => {
  test('runs on issue and pull request events and once a day, and on nothing else', () => {
    expect(keysUnder('on', 2)).toEqual(['issues', 'pull_request', 'schedule']);
  });

  test('watches exactly the issue and pull request events that move a stage', () => {
    expect(text).toContain('types: [assigned, unassigned, closed, reopened]');
    expect(text).toContain('types: [opened, reopened, closed, ready_for_review, edited]');
  });

  test('every action is pinned to a commit, with its version in a comment', () => {
    const uses = lines.filter((line) => /^\s*- uses:|^\s*uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/@[0-9a-f]{40} # v\d/);
  });

  test('the token is read-only except for the issues it assigns', () => {
    expect(text).toMatch(
      /permissions:\n {2}contents: read\n {2}issues: write\n {2}pull-requests: read\n/,
    );
  });

  test('scripts run from the default branch, never from the pull request', () => {
    expect(text).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(text).not.toContain('github.event.pull_request.head.sha');
    expect(text).not.toContain('github.head_ref');
  });

  test('the board is written only when the secret exists', () => {
    expect(text).toContain("if: env.BOARD_TOKEN != ''");
    expect(text).toContain('GH_TOKEN: ${{ secrets.BOARD_TOKEN }}');
  });

  test('a pull request from a fork or a bot assigns nobody', () => {
    expect(text).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(text).toContain("github.event.pull_request.user.type != 'Bot'");
  });

  test('untrusted values reach the shell through the environment, not the script text', () => {
    const start = text.indexOf('run: |');
    const script = text.slice(start, text.indexOf('\n\n', start));
    expect(script).toContain('gh issue edit');
    expect(script).not.toContain('${{');
  });

  test('runs one at a time, and a run that is going finishes', () => {
    expect(text).toContain('group: board');
    expect(text).toContain('cancel-in-progress: false');
  });
});
