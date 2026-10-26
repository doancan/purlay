/**
 * Preparing a release (`scripts/release.ts`, D-185).
 *
 * The changelog and the version are text, so they are judged as text: what moves, what stays,
 * what is refused. The git and GitHub half is run with a recording stand-in for both, so "a
 * tag that exists is never released again" and "a half-made release branch is cleaned up" are
 * behaviour this file watches happen, with no repository and no network.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Exec,
  type ExecResult,
  cli,
  nextVersion,
  type PrepareOptions,
  prepare,
  readVersion,
  rollChanges,
  setVersion,
  spawnIn,
} from './release-prepare';

const PACKAGE = '{\n  "name": "purlay",\n  "version": "0.0.0",\n  "private": true\n}\n';

const CHANGES = `# Purlay — Changelog

Notable changes, newest first. Releases get their own file: \`docs/changelog/v{x.y.z}.md\`.

---

## Unreleased

### Added

- **Appearance** — Dark is black now, and Midnight is a theme of its own (D-184)

### Fixed

- **Appearance** — One check box and one radio, drawn the same on every screen (D-182)

---

Earlier entries are in pre-0.1.0.md.
`;

describe('versions', () => {
  test('reads the one the root package.json holds', () => {
    expect(readVersion(PACKAGE)).toBe('0.0.0');
  });

  test('a bump is a word or a version, and goes up', () => {
    expect(nextVersion('0.0.0', 'patch')).toBe('0.0.1');
    expect(nextVersion('0.4.2', 'minor')).toBe('0.5.0');
    expect(nextVersion('0.4.2', 'major')).toBe('1.0.0');
    expect(nextVersion('0.4.2', '0.9.0')).toBe('0.9.0');
  });

  test.each(['v0.9.0', '1.2', '1.2.3-rc.1', 'latest', '', '01.2.3'])(
    'refuses %p, which is not a plain x.y.z',
    (request) => {
      expect(() => nextVersion('0.4.2', request)).toThrow(/x\.y\.z|patch, minor or major/);
    },
  );

  test('refuses a version that is not newer than the one released', () => {
    expect(() => nextVersion('0.4.2', '0.4.2')).toThrow('is not newer than 0.4.2');
    expect(() => nextVersion('0.4.2', '0.3.9')).toThrow('is not newer than 0.4.2');
  });

  test('writes the version where it was, and nowhere else', () => {
    const written = setVersion(PACKAGE, '0.1.0');
    expect(written).toBe(PACKAGE.replace('0.0.0', '0.1.0'));
  });

  test('refuses a package.json that holds no version to replace', () => {
    expect(() => setVersion('{ "name": "purlay" }\n', '0.1.0')).toThrow('no "version"');
    expect(() => readVersion('{ "name": "purlay" }\n')).toThrow('no "version"');
  });
});

describe('rolling the changelog', () => {
  const rolled = rollChanges(CHANGES, '0.1.0', '2026-10-26');

  test('moves what was unreleased into the release notes, verbatim, under a heading', () => {
    expect(rolled.notes.startsWith('# Purlay v0.1.0 — 2026-10-26\n\n### Added\n')).toBe(true);
    expect(rolled.notes).toContain('- **Appearance** — Dark is black now');
    expect(rolled.notes).toContain('### Fixed');
    expect(rolled.notes.endsWith('\n')).toBe(true);
  });

  test('leaves Unreleased empty and says so', () => {
    expect(rolled.changes).toContain('## Unreleased\n\n_Nothing yet._\n\n---');
    expect(rolled.changes).not.toContain('Dark is black now');
  });

  test('leaves everything before and after it as it was', () => {
    expect(rolled.changes.startsWith(CHANGES.slice(0, CHANGES.indexOf('## Unreleased')))).toBe(
      true,
    );
    expect(rolled.changes.endsWith('---\n\nEarlier entries are in pre-0.1.0.md.\n')).toBe(true);
  });

  test('refuses to release nothing', () => {
    expect(() => rollChanges(rolled.changes, '0.2.0', '2026-10-27')).toThrow(
      'nothing is unreleased',
    );
  });

  test('refuses an Unreleased that is not in the standard shape, and says what is wrong', () => {
    const prose = CHANGES.replace('### Added', '### Change — 2026-10-24: a black dark theme');
    expect(() => rollChanges(prose, '0.1.0', '2026-10-26')).toThrow(
      /not in the standard shape[\s\S]*is not a category/,
    );
  });

  test('refuses a changelog with no Unreleased heading, rather than guessing where it ends', () => {
    expect(() => rollChanges('# Changelog\n\n### Added\n', '0.1.0', '2026-10-26')).toThrow(
      'no "## Unreleased"',
    );
  });

  test('refuses an Unreleased that never ends, since it cannot say what is in it', () => {
    expect(() =>
      rollChanges('## Unreleased\n\n### Added\n\n- **A** — x\n', '0.1.0', '2026-10-26'),
    ).toThrow('no "---"');
  });
});

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

interface Recorder {
  readonly root: string;
  readonly calls: string[];
  readonly exec: Exec;
}

const STALE = PACKAGE.replace('0.0.0', '0.7.0');

/** What `git show origin/main:<file>` says; the files on disk are stale on purpose. */
const SHOWN: Record<string, Partial<ExecResult>> = {
  'git show origin/main:package.json': { stdout: PACKAGE },
  'git show origin/main:docs/changelog/changes.md': { stdout: CHANGES },
};

/** A checkout holding the two files, and an `exec` that records and answers as the case says. */
const checkout = (answers: Record<string, Partial<ExecResult>> = {}): Recorder => {
  const root = mkdtempSync(join(tmpdir(), 'release-prepare-'));
  sandboxes.push(root);
  mkdirSync(join(root, 'docs/changelog'), { recursive: true });
  writeFileSync(join(root, 'package.json'), STALE);
  writeFileSync(join(root, 'docs/changelog/changes.md'), '# a local copy that is not main\n');
  const calls: string[] = [];
  const exec: Exec = (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    // A key ending in `$` is the whole command; any other is how it begins.
    const answer = Object.entries({ ...SHOWN, ...answers }).find(([key]) =>
      key.endsWith('$') ? line === key.slice(0, -1) : line.startsWith(key),
    )?.[1];
    return { code: 0, stdout: '', stderr: '', ...answer };
  };
  return { root, calls, exec };
};

const options = (place: Recorder, request = 'minor', dryRun = false): PrepareOptions => ({
  root: place.root,
  request,
  date: '2026-10-26',
  exec: place.exec,
  dryRun,
});

const BRANCH = 'chore/release-v0.1.0';
const PR = { 'gh pr create': { stdout: 'https://github.com/acme/purlay/pull/9\n' } };
const at = (place: Recorder, prefix: string): number =>
  place.calls.findIndex((call) => call.startsWith(prefix));

describe('preparing a release', () => {
  test('branches from origin/main, writes the three files, commits, pushes and opens the pull request', () => {
    const place = checkout(PR);
    const result = prepare(options(place));
    expect(result.version).toBe('0.1.0');
    expect(result.pullRequest).toBe('https://github.com/acme/purlay/pull/9');
    const order = [
      'git status --porcelain',
      'git fetch origin main',
      'git show origin/main:package.json',
      'git show origin/main:docs/changelog/changes.md',
      'git ls-remote --tags origin refs/tags/v0.1.0',
      `git switch -c ${BRANCH} origin/main`,
      'git add package.json docs/changelog',
      'git commit -m chore(release): v0.1.0',
      `git push -u origin ${BRANCH}`,
      'gh pr create',
    ];
    const positions = order.map((prefix) => at(place, prefix));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(readFileSync(join(place.root, 'package.json'), 'utf8')).toContain('"version": "0.1.0"');
    expect(readFileSync(join(place.root, 'docs/changelog/v0.1.0.md'), 'utf8')).toContain(
      '# Purlay v0.1.0 — 2026-10-26',
    );
    expect(readFileSync(join(place.root, 'docs/changelog/changes.md'), 'utf8')).toContain(
      '_Nothing yet._',
    );
  });

  test('says in the pull request what merging it does', () => {
    const place = checkout(PR);
    prepare(options(place));
    const create = place.calls.find((call) => call.startsWith('gh pr create')) ?? '';
    expect(create).toContain('--base main');
    expect(create).toContain(`--head ${BRANCH}`);
    expect(create).toContain('deploys');
    expect(create).toContain('v0.1.0');
  });

  test('a commit message with no assistant in it and no project-management word', () => {
    const place = checkout({ 'gh pr create': { stdout: 'x\n' } });
    prepare(options(place));
    const commit = place.calls.find((call) => call.startsWith('git commit')) ?? '';
    expect(commit).not.toMatch(/claude|co-authored|task|sprint|ticket|issue|story|epic|adr/i);
  });

  test('a dry run reads and judges, and changes nothing', () => {
    const place = checkout();
    const result = prepare(options(place, 'minor', true));
    expect(result.version).toBe('0.1.0');
    expect(result.pullRequest).toBeUndefined();
    expect(place.calls.filter((call) => /^(git (switch|add|commit|push)|gh)/.test(call))).toEqual(
      [],
    );
    expect(readFileSync(join(place.root, 'package.json'), 'utf8')).toBe(STALE);
  });

  test('refuses a working tree with changes in it, before touching anything', () => {
    const place = checkout({ 'git status': { stdout: ' M scripts/deploy.sh\n' } });
    expect(() => prepare(options(place))).toThrow('working tree is not clean');
    expect(place.calls).toEqual(['git status --porcelain']);
  });

  test('refuses a version whose tag already exists on the remote', () => {
    const place = checkout({ 'git ls-remote': { stdout: 'abc\trefs/tags/v0.1.0\n' } });
    expect(() => prepare(options(place))).toThrow('v0.1.0 already exists');
    expect(place.calls.some((call) => call.startsWith('git switch'))).toBe(false);
  });

  test('judges origin/main, not a stale local copy: the version and the entries come from it', () => {
    const place = checkout({ 'gh pr create': { stdout: 'x\n' } });
    const result = prepare(options(place));
    // The stale package.json on disk says 0.7.0; a bump of that would be 0.8.0.
    expect(result.version).toBe('0.1.0');
    const notes = readFileSync(join(place.root, 'docs/changelog/v0.1.0.md'), 'utf8');
    expect(notes).toContain('Dark is black now');
    expect(readFileSync(join(place.root, 'package.json'), 'utf8')).toBe(
      PACKAGE.replace('0.0.0', '0.1.0'),
    );
  });

  test('refuses an Unreleased that is not in the standard shape before it makes a branch', () => {
    const place = checkout({
      'git show origin/main:docs/changelog/changes.md': {
        stdout: CHANGES.replace('### Added', '### Change — 2026-10-24: prose'),
      },
    });
    expect(() => prepare(options(place))).toThrow('not in the standard shape');
    expect(place.calls.some((call) => call.startsWith('git switch'))).toBe(false);
  });

  test('a failing command says what it was and what it said', () => {
    const place = checkout({ 'git fetch': { code: 128, stderr: 'no route to host' } });
    expect(() => prepare(options(place))).toThrow(/git fetch origin main.*no route to host/s);
  });
});

describe('when it fails half way', () => {
  test('puts the half-made branch away, in the order git needs: the files, the branch you are on, then the branch', () => {
    const place = checkout({ 'git push': { code: 1, stderr: 'rejected' } });
    expect(() => prepare(options(place))).toThrow('git push');
    const reset = at(place, 'git reset --hard');
    const clean = at(place, 'git clean -f -- docs/changelog/v0.1.0.md');
    const back = place.calls.indexOf('git switch -');
    const drop = at(place, `git branch -D ${BRANCH}`);
    expect([reset, clean, back, drop].every((index) => index >= 0)).toBe(true);
    expect([reset, clean, back, drop]).toEqual([reset, clean, back, drop].sort((a, b) => a - b));
    // Nothing reached the remote, so nothing is deleted there.
    expect(place.calls.some((call) => call.startsWith('git push origin --delete'))).toBe(false);
  });

  test('a pull request that GitHub refuses after the push leaves no branch on the remote either', () => {
    const place = checkout({ 'gh pr create': { code: 1, stderr: 'rate limited' } });
    expect(() => prepare(options(place))).toThrow('rate limited');
    expect(place.calls).toContain(`git push origin --delete ${BRANCH}`);
    expect(at(place, `git push origin --delete ${BRANCH}`)).toBeGreaterThan(
      at(place, `git push -u origin ${BRANCH}`),
    );
  });

  test('says so when the clean-up could not run, instead of leaving the person on the branch unaware', () => {
    const place = checkout({
      'git push': { code: 1, stderr: 'rejected' },
      'git switch -$': { code: 1, stderr: 'conflict' },
    });
    expect(() => prepare(options(place))).toThrow(
      /rejected[\s\S]*clean-up could not run: git switch -/,
    );
  });
});

describe('the command', () => {
  const io = (
    place: Recorder,
  ): { readonly io: Parameters<typeof cli>[1]; readonly out: string[]; readonly err: string[] } => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: {
        root: place.root,
        exec: place.exec,
        today: '2026-10-26',
        out: (line) => out.push(line),
        err: (line) => err.push(line),
      },
      out,
      err,
    };
  };

  test('says how it is used, and fails with 2, when it is given nothing or something it does not know', () => {
    for (const argv of [[], ['minor', '--bogus']]) {
      const place = checkout();
      const said = io(place);
      expect(cli(argv, said.io)).toBe(2);
      expect(said.err.join('\n')).toContain('usage: bun run release');
      expect(place.calls).toEqual([]);
    }
  });

  test('a dry run says what it would do and exits 0', () => {
    const place = checkout();
    const said = io(place);
    expect(cli(['minor', '--dry-run'], said.io)).toBe(0);
    expect(said.out).toEqual(['would release v0.1.0: nothing was changed']);
  });

  test('a release says where the pull request is and exits 0', () => {
    const place = checkout(PR);
    const said = io(place);
    expect(cli(['minor'], said.io)).toBe(0);
    expect(said.out).toEqual(['release v0.1.0 is prepared: https://github.com/acme/purlay/pull/9']);
  });

  test('a refusal is said as FAIL, with what was wrong, and exits 1', () => {
    const place = checkout({ 'git status': { stdout: ' M x\n' } });
    const said = io(place);
    expect(cli(['minor'], said.io)).toBe(1);
    expect(said.err.join('\n')).toMatch(/^FAIL: the working tree is not clean/);
  });

  test('runs real commands where it is told to, and says what they said', () => {
    const exec = spawnIn(import.meta.dir);
    expect(exec('git', ['--version']).stdout).toContain('git version');
    const failed = exec('git', ['no-such-subcommand']);
    expect(failed.code).not.toBe(0);
    expect(failed.stderr).not.toBe('');
  });

  test('is what `bun run release` runs: no arguments is a usage error', () => {
    const result = Bun.spawnSync(['bun', '--no-env-file', 'scripts/release.ts'], {
      cwd: join(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('usage: bun run release');
  });
});
