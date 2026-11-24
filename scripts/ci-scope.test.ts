/** What a run has to prove: when a change is light, and when a commit on main was verified before it got there (D-332). */
import { describe, expect, test } from 'bun:test';
import type { Run } from './ci-changes';
import { DEPTH, isLight, main, movesOnlyTheVersion, reuses as askReuse } from './ci-scope';

const bump = [
  '@@ -1,5 +1,5 @@',
  ' {',
  '   "name": "purlay",',
  '-  "version": "0.7.1",',
  '+  "version": "0.8.0",',
  '   "private": true,',
].join('\n');

describe('a light change', () => {
  test('is documents alone, whichever of them and however many', () => {
    expect(isLight([{ filename: 'docs/UX.md' }, { filename: 'docs/changelog/v0.8.0.md' }])).toBe(
      true,
    );
    expect(isLight([{ filename: 'README.md' }])).toBe(true);
  });

  test('is a version bump of package.json beside the notes: a release', () => {
    expect(
      isLight([
        { filename: 'package.json', patch: bump },
        { filename: 'docs/changelog/changes.md' },
        { filename: 'docs/changelog/v0.8.0.md' },
      ]),
    ).toBe(true);
  });

  test('is not a package.json change that moves anything but the version', () => {
    const dependency = bump.replace(
      '   "private": true,',
      '-  "private": true,\n+  "private": false,',
    );
    expect(movesOnlyTheVersion(dependency)).toBe(false);
    expect(
      movesOnlyTheVersion(
        '-    "left-pad": "1.0.0",\n+    "left-pad": "1.0.1",\n-  "version": "0.1.0",\n+  "version": "0.1.1",',
      ),
    ).toBe(false);
    expect(isLight([{ filename: 'package.json', patch: dependency }])).toBe(false);
  });

  test('is not a patch GitHub did not send, or one that moves two versions or none', () => {
    expect(isLight([{ filename: 'package.json' }])).toBe(false);
    expect(movesOnlyTheVersion(undefined)).toBe(false);
    expect(movesOnlyTheVersion('+  "version": "0.8.0",')).toBe(false);
    expect(movesOnlyTheVersion('')).toBe(false);
  });

  test('is not one source, script, workflow, test or dependency file among the documents', () => {
    for (const filename of [
      'apps/web/src/index.css',
      'scripts/ci-gate.ts',
      '.github/workflows/ci.yml',
      'bun.lock',
      'packages/tokens/tokens.json',
      'docs/../scripts/x.ts',
      'apps/api/src/released-manifests.json',
    ]) {
      expect(isLight([{ filename: 'docs/UX.md' }, { filename }]), filename).toBe(false);
    }
  });

  test('is not a document moved out of docs, nor a source file moved into it', () => {
    expect(isLight([{ filename: 'docs/x.md', previous_filename: 'scripts/x.ts' }])).toBe(false);
    expect(isLight([{ filename: 'scripts/x.ts', previous_filename: 'docs/x.md' }])).toBe(false);
  });

  test('is never a change with no files: nothing was seen, so nothing is light', () => {
    expect(isLight([])).toBe(false);
  });
});

/** A GitHub that answers from a table: the `gh api` path (and its jq) picks the answer. */
const github =
  (answers: Record<string, string>): Run =>
  (command) => {
    const path = command[2] ?? '';
    const hit = Object.entries(answers).find(([key]) => path.includes(key));
    return hit === undefined
      ? { exitCode: 1, stdout: '', stderr: `no answer for ${path}` }
      : { exitCode: 0, stdout: hit[1], stderr: '' };
  };

/** No test waits: the pauses are the module's to take, and these only say how long it would have. */
const noSleep = (seconds: number): void => {
  expect(seconds).toBeGreaterThan(0);
};

const reuses = (
  repository: string,
  commit: string,
  spawn: Run,
  depth: number = DEPTH,
  sleep: (seconds: number) => void = noSleep,
): boolean => askReuse(repository, commit, spawn, depth, sleep);

/** The jobs of a full run, named as GitHub names them: a matrix by its legs. */
const FULL = [
  'static\tsuccess',
  'schema\tsuccess',
  'browser (chromium-dark, suite)\tsuccess',
  'browser (chromium-dark, measurements)\tsuccess',
  'browser (chromium-light, suite)\tsuccess',
  'module-suites (chat)\tsuccess',
  'module-suites (none)\tsuccess',
  'verify\tsuccess',
].join('\n');
const LIGHT =
  'static\tsuccess\nschema\tskipped\nlight-suite\tsuccess\nbrowser\tskipped\nverify\tsuccess';

/** Main's commit C, in pull request 7 whose head H has the same tree and whose run is `jobs`. */
const world = (jobs: string, overrides: Record<string, string> = {}): Record<string, string> => ({
  'git/commits/C': 'treeC',
  'commits/C/pulls': '7 H B',
  'git/commits/H': 'treeC',
  'head_sha=H': '99',
  'runs/99/jobs': jobs,
  ...overrides,
});

describe('a commit on main whose content was verified before', () => {
  test('is one whose tree is a pull request head tree, proven by every heavy job having run', () => {
    expect(reuses('o/r', 'C', github(world(FULL)), 3, noSleep)).toBe(true);
  });

  test('is not one whose tree differs: main moved and the rebase changed the content', () => {
    expect(
      reuses('o/r', 'C', github(world(FULL, { 'git/commits/H': 'treeOther' })), 3, noSleep),
    ).toBe(false);
  });

  test('is not one a heavy job was skipped for, or one whose verify did not succeed', () => {
    expect(
      reuses(
        'o/r',
        'C',
        github(
          world(
            FULL.replace(
              'browser (chromium-light, suite)\tsuccess',
              'browser (chromium-light, suite)\tskipped',
            ),
          ),
        ),
      ),
    ).toBe(false);
    expect(
      reuses('o/r', 'C', github(world(FULL.replace('verify\tsuccess', 'verify\tfailure')))),
    ).toBe(false);
    expect(
      reuses('o/r', 'C', github(world(FULL.replace('schema\tsuccess', 'schema\tfailure')))),
    ).toBe(false);
  });

  test('is not one whose matrix has a leg that did not succeed, or has no leg at all', () => {
    expect(
      reuses(
        'o/r',
        'C',
        github(
          world(FULL.replace('module-suites (none)\tsuccess', 'module-suites (none)\tfailure')),
        ),
      ),
    ).toBe(false);
    expect(
      reuses(
        'o/r',
        'C',
        github(
          world(
            FULL.split('\n')
              .filter((line) => !line.startsWith('browser'))
              .join('\n'),
          ),
        ),
      ),
    ).toBe(false);
    // A job that only begins with the name is not one of its legs.
    expect(
      reuses('o/r', 'C', github(world(FULL.replace('static\tsuccess', 'static-extra\tsuccess')))),
    ).toBe(false);
  });

  test('is not one with no finished run, no pull request or no answer at all', () => {
    expect(reuses('o/r', 'C', github(world(FULL, { 'head_sha=H': '' })))).toBe(false);
    expect(reuses('o/r', 'C', github(world(FULL, { 'commits/C/pulls': '' })))).toBe(false);
    expect(reuses('o/r', 'C', github({}))).toBe(false);
  });

  test('is a light change on a base that is itself reused: a release on a tested tree', () => {
    const answers = world(LIGHT, {
      // The base B is the tip of an earlier pull request 6 whose head P has B's tree and a full run.
      'git/commits/B': 'treeB',
      'commits/B/pulls': '6 P Q',
      'git/commits/P': 'treeB',
      'head_sha=P': '55',
      'runs/55/jobs': FULL,
    });
    expect(reuses('o/r', 'C', github(answers))).toBe(true);
  });

  test('is not a light change on a base nobody verified', () => {
    const answers = world(LIGHT, {
      'git/commits/B': 'treeB',
      'commits/B/pulls': '',
    });
    expect(reuses('o/r', 'C', github(answers))).toBe(false);
  });

  test('waits for GitHub to link the commit to its pull request, and asks again a few times', () => {
    let asked = 0;
    const slept: number[] = [];
    const eventually: Run = (command) => {
      const path = command[2] ?? '';
      if (path.includes('commits/C/pulls')) {
        asked += 1;
        return { exitCode: 0, stdout: asked < 3 ? '' : '7 H B', stderr: '' };
      }
      return github(world(FULL))(command);
    };
    expect(reuses('o/r', 'C', eventually, 3, (seconds) => slept.push(seconds))).toBe(true);
    expect(slept).toEqual([5, 10]);
  });

  test('gives up after the waits it has, and says no', () => {
    const slept: number[] = [];
    expect(
      reuses('o/r', 'C', github(world(FULL, { 'commits/C/pulls': '' })), 3, (s) => slept.push(s)),
    ).toBe(false);
    expect(slept).toEqual([5, 10, 15]);
  });

  test('is not traced back further than the depth allows', () => {
    expect(reuses('o/r', 'C', github(world(LIGHT)), 0)).toBe(false);
  });
});

describe('the lines CI reads', () => {
  test('say a pull request of documents is light and nothing is reused on one', () => {
    const lines = main({ EVENT: 'pull_request', REPOSITORY: 'o/r', NUMBER: '5' }, () => ({
      exitCode: 0,
      stdout: '{"filename":"docs/UX.md"}',
      stderr: '',
    }));
    expect(lines).toBe('light=true\nreuse=false');
  });

  test('say a push to main is never light, and ask whether its content was verified', () => {
    const lines = main(
      { EVENT: 'push', BRANCH: 'main', REPOSITORY: 'o/r', COMMIT: 'C' },
      github(world(FULL)),
    );
    expect(lines).toBe('light=false\nreuse=true');
  });

  test('say neither for any other event, a push to another branch included', () => {
    expect(
      main({ EVENT: 'push', BRANCH: 'feature', REPOSITORY: 'o/r', COMMIT: 'C' }, github({})),
    ).toBe('light=false\nreuse=false');
    expect(main({ EVENT: 'workflow_dispatch' }, github({}))).toBe('light=false\nreuse=false');
  });

  test('refuse to guess when the pull request’s files cannot be read', () => {
    expect(() =>
      main({ EVENT: 'pull_request', REPOSITORY: 'o/r', NUMBER: '5' }, github({})),
    ).toThrow();
  });
});
