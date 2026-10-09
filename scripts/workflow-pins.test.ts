/**
 * Every third-party action is pinned to a commit, not a tag (#247).
 *
 * A tag is a pointer its owner can move. A workflow that says `@v2` runs whatever
 * `v2` points at on the day it runs — including the day the owner's account is
 * taken over — with the repository's token in its environment. A full commit
 * SHA cannot be moved. The trailing `# vX.Y.Z` comment keeps it readable, and
 * Dependabot's github-actions ecosystem keeps proposing the next SHA.
 *
 * The same rule is the repository setting `sha_pinning_required`; this test is
 * the half that fails in the pull request, before the setting would fail the run.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = join(import.meta.dir, '../.github/workflows');
const ACTIONS = join(import.meta.dir, '../.github/actions');

/** The `uses:` lines that are not a pinned commit with a version comment. A local path is exempt. */
const unpinnedUses = (text: string): readonly string[] =>
  text.split('\n').flatMap((line) => {
    const match = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
    if (match === null) return [];
    const [, target = '', rest = ''] = match;
    if (target.startsWith('./')) return [];
    const pinned = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(target);
    const versioned = /^\s*#\s*v\d+(\.\d+){0,2}\S*\s*$/.test(rest);
    return pinned && versioned ? [] : [`${target}${rest}`.trim()];
  });

const yamlFiles = (directory: string): string[] => {
  try {
    return readdirSync(directory, { recursive: true, encoding: 'utf8' })
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => join(directory, name));
  } catch {
    return [];
  }
};

/**
 * The checkouts that leave the job's token in `.git/config`. `actions/checkout` stores the
 * token there by default, where every later step of the job — an installed package's
 * install script included — can read it. No job here pushes, so none keeps it.
 */
const checkoutsKeepingCredentials = (text: string): readonly string[] => {
  const lines = text.split('\n');
  return lines.flatMap((line, index) => {
    const match = /^(\s*)(?:-\s+)?uses:\s*actions\/checkout@/.exec(line);
    if (match === null) return [];
    const indent = (match[1] ?? '').length;
    // The step ends at the next line that starts a sibling step.
    let end = index + 1;
    while (
      end < lines.length &&
      !new RegExp(`^\\s{0,${String(indent)}}-\\s`).test(lines[end] ?? '')
    ) {
      end += 1;
    }
    const step = lines.slice(index, end).join('\n');
    return /persist-credentials:\s*false\b/.test(step) ? [] : [`line ${String(index + 1)}`];
  });
};

describe('workflow pins', () => {
  test('the checker sees a tag, a branch, a short SHA and a missing version comment', () => {
    const sha = 'a'.repeat(40);
    expect(unpinnedUses('  - uses: actions/checkout@v7')).toEqual(['actions/checkout@v7']);
    expect(unpinnedUses('      uses: actions/checkout@main # v7')).toHaveLength(1);
    expect(unpinnedUses(`      - uses: actions/checkout@${'a'.repeat(39)} # v7.0.1`)).toHaveLength(
      1,
    );
    expect(unpinnedUses(`      - uses: actions/checkout@${sha}`)).toHaveLength(1);
    expect(unpinnedUses(`      - uses: actions/checkout@${sha} # v7.0.1`)).toEqual([]);
    expect(unpinnedUses('      - uses: ./.github/actions/local')).toEqual([]);
  });

  test('every workflow and composite action pins each uses: to a 40-hex SHA with a version comment', () => {
    const all = [...yamlFiles(WORKFLOWS), ...yamlFiles(ACTIONS)];
    // The positive condition: there are workflows to judge (CONTRIBUTING §6.4).
    expect(all.length).toBeGreaterThan(0);
    const offenders = all.flatMap((file) =>
      unpinnedUses(readFileSync(file, 'utf8')).map((use) => `${file}: ${use}`),
    );
    expect(offenders).toEqual([]);
  });

  test('the credentials checker sees a checkout that keeps them, and one that does not', () => {
    const keeps = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - uses: actions/checkout@aaa # v7',
      '      - run: x',
    ].join('\n');
    const drops = [
      '      - uses: actions/checkout@aaa # v7',
      '        with:',
      '          persist-credentials: false',
      '      - run: x',
    ].join('\n');
    // `persist-credentials: false` belonging to the NEXT step does not count.
    const next = [
      '      - uses: actions/checkout@aaa # v7',
      '      - uses: other/action@bbb # v1',
      '        with:',
      '          persist-credentials: false',
    ].join('\n');
    expect(checkoutsKeepingCredentials(keeps)).toEqual(['line 4']);
    expect(checkoutsKeepingCredentials(drops)).toEqual([]);
    expect(checkoutsKeepingCredentials(next)).toEqual(['line 1']);
  });

  test('no checkout leaves the job token in the working copy', () => {
    const all = [...yamlFiles(WORKFLOWS), ...yamlFiles(ACTIONS)];
    expect(all.length).toBeGreaterThan(0);
    const offenders = all.flatMap((file) =>
      checkoutsKeepingCredentials(readFileSync(file, 'utf8')).map((where) => `${file}: ${where}`),
    );
    expect(offenders).toEqual([]);
  });
});
