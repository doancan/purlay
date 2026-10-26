/**
 * Prepare a release: the version, the release notes, and the pull request that carries them (D-185).
 * The command is `scripts/release.ts`, which only starts `cli` below:
 *
 *   bun run release -- <patch|minor|major|x.y.z> [--dry-run]
 *
 * A release is a pull request, because `main` is protected and nothing lands on it any other
 * way. This opens it: a `chore/release-v<x.y.z>` branch from `origin/main` that
 *
 * - moves everything under `## Unreleased` in `docs/changelog/changes.md` into
 *   `docs/changelog/v<x.y.z>.md` and leaves Unreleased empty, and
 * - sets `"version"` in the root `package.json` — the one home of the version.
 *
 * **Merging it is the release.** The `deploy` workflow deploys every commit that lands on `main`;
 * when the version in `package.json` is one with no tag yet, it also tags that commit and
 * publishes a GitHub Release (`scripts/release-publish.sh`). A merge that does not change the
 * version deploys and releases nothing: version numbers mark moments, they are not a count of merges.
 *
 * What it judges comes from `origin/main`, read with `git show`, never from whatever is on disk:
 * a local copy that is behind would otherwise release a version that already exists.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTHING, problemsIn } from './changelog';

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a command in the repository. Injected, so the git and GitHub half can be watched without either. */
export type Exec = (command: string, args: readonly string[]) => ExecResult;

type Triple = readonly [number, number, number];

const PLAIN_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const parse = (version: string): Triple | undefined => {
  const match = PLAIN_VERSION.exec(version);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const newer = (candidate: Triple, current: Triple): boolean => {
  for (const index of [0, 1, 2] as const) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
};

const VERSION_LINE = /^ {2}"version":\s*"([^"]+)"/m;

/** The version the root package.json holds. */
export const readVersion = (packageJson: string): string => {
  const match = VERSION_LINE.exec(packageJson);
  if (match?.[1] === undefined) throw new Error('package.json has no "version" line');
  return match[1];
};

/** The package.json with its version replaced; every other byte is as it was. */
export const setVersion = (packageJson: string, version: string): string => {
  if (!VERSION_LINE.test(packageJson)) throw new Error('package.json has no "version" line');
  return packageJson.replace(VERSION_LINE, `  "version": "${version}"`);
};

/** `patch`, `minor`, `major`, or a plain x.y.z that is newer than the one released. */
export const nextVersion = (current: string, request: string): string => {
  const base = parse(current);
  if (base === undefined) throw new Error(`the current version '${current}' is not a plain x.y.z`);
  const [major, minor, patch] = base;
  if (request === 'patch') return [major, minor, patch + 1].map(String).join('.');
  if (request === 'minor') return [major, minor + 1, 0].map(String).join('.');
  if (request === 'major') return [major + 1, 0, 0].map(String).join('.');
  const wanted = parse(request);
  if (wanted === undefined) {
    throw new Error(
      `'${request}' is neither patch, minor or major, nor a plain x.y.z (no leading v, no suffix)`,
    );
  }
  if (!newer(wanted, base)) throw new Error(`${request} is not newer than ${current}`);
  return request;
};

/**
 * Moves what is under `## Unreleased` (up to the first `---` after it) into the release's notes.
 * Both ends are looked for, not assumed: a changelog whose shape changed is refused rather than
 * cut somewhere that merely looks right. What moves must be the standard shape (`./changelog`:
 * Added, Changed, Deprecated, Removed, Fixed, Security, as bullets), so every release's notes read alike.
 * A `---` inside the Unreleased entries would end the section early; none belongs there.
 */
export const rollChanges = (
  changes: string,
  version: string,
  date: string,
): { readonly changes: string; readonly notes: string } => {
  const heading = /^## Unreleased[ \t]*$/m.exec(changes);
  if (heading === null) throw new Error('changes.md has no "## Unreleased" heading');
  const afterHeading = heading.index + heading[0].length;
  const end = /^---[ \t]*$/m.exec(changes.slice(afterHeading));
  if (end === null)
    throw new Error('changes.md has no "---" after "## Unreleased" to end the section');
  const bodyEnd = afterHeading + end.index;
  const body = changes.slice(afterHeading, bodyEnd).trim();
  if (body === '' || body === NOTHING)
    throw new Error('nothing is unreleased: there is nothing to release');
  const problems = problemsIn(body);
  if (problems.length > 0) {
    throw new Error(`Unreleased is not in the standard shape:\n  ${problems.join('\n  ')}`);
  }
  return {
    notes: `# Purlay v${version} — ${date}\n\n${body}\n`,
    changes: `${changes.slice(0, heading.index)}## Unreleased\n\n${NOTHING}\n\n${changes.slice(bodyEnd)}`,
  };
};

export interface PrepareOptions {
  readonly root: string;
  /** `patch`, `minor`, `major` or x.y.z. */
  readonly request: string;
  /** The release's date, YYYY-MM-DD, in the heading of its notes. */
  readonly date: string;
  readonly exec: Exec;
  /** Judge and report; change nothing. */
  readonly dryRun: boolean;
}

export interface Prepared {
  readonly version: string;
  /** The pull request's address; absent on a dry run. */
  readonly pullRequest?: string;
}

export const prepare = (options: PrepareOptions): Prepared => {
  const { root, request, date, exec, dryRun } = options;
  const run = (command: string, ...args: readonly string[]): string => {
    const result = exec(command, args);
    if (result.code !== 0) {
      throw new Error(
        `${[command, ...args].join(' ')} failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`,
      );
    }
    return result.stdout;
  };

  if (run('git', 'status', '--porcelain').trim() !== '') {
    throw new Error('the working tree is not clean; commit or stash what is there, then release');
  }
  run('git', 'fetch', 'origin', 'main');
  const packageJson = run('git', 'show', 'origin/main:package.json');
  const changes = run('git', 'show', 'origin/main:docs/changelog/changes.md');

  const version = nextVersion(readVersion(packageJson), request);
  const rolled = rollChanges(changes, version, date);
  if (run('git', 'ls-remote', '--tags', 'origin', `refs/tags/v${version}`).trim() !== '') {
    throw new Error(`the tag v${version} already exists on the remote`);
  }
  if (dryRun) return { version };

  const branch = `chore/release-v${version}`;
  run('git', 'switch', '-c', branch, 'origin/main');
  let pushed = false;
  try {
    writeFileSync(join(root, 'package.json'), setVersion(packageJson, version));
    writeFileSync(join(root, 'docs/changelog/changes.md'), rolled.changes);
    writeFileSync(join(root, `docs/changelog/v${version}.md`), rolled.notes);
    run('git', 'add', 'package.json', 'docs/changelog');
    run('git', 'commit', '-m', `chore(release): v${version}`);
    run('git', 'push', '-u', 'origin', branch);
    pushed = true;
    const body = [
      `Releases v${version}: the version, and the notes moved out of Unreleased into docs/changelog/v${version}.md.`,
      '',
      'Merging this deploys the commit to the server (the deploy workflow), then tags it',
      `v${version} and publishes the GitHub Release.`,
    ].join('\n');
    const created = run(
      'gh',
      'pr',
      'create',
      '--base',
      'main',
      '--head',
      branch,
      '--title',
      `chore(release): v${version}`,
      '--body',
      body,
    );
    const address = created.trim().split('\n').at(-1);
    return address === undefined || address === ''
      ? { version }
      : { version, pullRequest: address };
  } catch (error) {
    // Leave the checkout where it was found, with no half-made release branch in it — and none on the
    // remote if it got that far. A step of the clean-up that fails is said, not swallowed.
    const steps: readonly (readonly [string, readonly string[]])[] = [
      ['git', ['reset', '--hard']],
      ['git', ['clean', '-f', '--', `docs/changelog/v${version}.md`]],
      ['git', ['switch', '-']],
      ['git', ['branch', '-D', branch]],
      ...(pushed ? ([['git', ['push', 'origin', '--delete', branch]]] as const) : []),
    ];
    const left = steps
      .filter(([command, args]) => exec(command, args).code !== 0)
      .map(([command, args]) => [command, ...args].join(' '));
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      left.length === 0
        ? reason
        : `${reason}\n  and the clean-up could not run: ${left.join('; ')}. Look at ${branch}.`,
    );
  }
};

/** `exec` for real: runs the command in `cwd` and says what came out. */
export const spawnIn =
  (cwd: string): Exec =>
  (command, args) => {
    const run = Bun.spawnSync([command, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    return { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
  };

export interface CliIo {
  readonly root: string;
  readonly exec: Exec;
  /** Today, YYYY-MM-DD. */
  readonly today: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** What `bun run release` does, as the exit code it ends with. */
export const cli = (argv: readonly string[], io: CliIo): number => {
  const [request, flag] = argv;
  if (request === undefined || (flag !== undefined && flag !== '--dry-run')) {
    io.err('usage: bun run release -- <patch|minor|major|x.y.z> [--dry-run]');
    return 2;
  }
  const dryRun = flag === '--dry-run';
  try {
    const result = prepare({ root: io.root, request, date: io.today, exec: io.exec, dryRun });
    io.out(
      dryRun
        ? `would release v${result.version}: nothing was changed`
        : `release v${result.version} is prepared: ${result.pullRequest ?? 'the pull request'}`,
    );
    return 0;
  } catch (error) {
    io.err(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
};
