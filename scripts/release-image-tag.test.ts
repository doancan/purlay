/**
 * Naming a release's image (`scripts/release-image-tag.sh`, D-262).
 *
 * Run, not read: each case is a git checkout with `gh` and `docker` replaced by stubs that log what they were
 * asked, so "a commit that is no release changes nothing" and "`release` never moves back" are watched happen.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');
const IMAGE = 'ghcr.io/acme/purlay-api';
const quiet = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const run = Bun.spawnSync(['git', ...args], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
    env: { ...quiet, PATH: process.env['PATH'] ?? '', HOME: cwd },
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
};

interface Sandbox {
  readonly root: string;
  readonly checkout: string;
  /** The commit tagged v0.2.0, then v0.3.0, then one more that is no release. */
  readonly commits: { readonly old: string; readonly release: string; readonly after: string };
  readonly log: string;
}

const commit = (checkout: string, version: string): string => {
  writeFileSync(
    join(checkout, 'package.json'),
    `{\n  "name": "purlay",\n  "version": "${version}",\n  "private": true\n}\n`,
  );
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '--allow-empty', '-m', version);
  return git(checkout, 'rev-parse', 'HEAD');
};

const sandbox = (): Sandbox => {
  const root = mkdtempSync(join(tmpdir(), 'release-image-'));
  sandboxes.push(root);
  const checkout = join(root, 'checkout');
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  git(checkout, 'init', '--quiet', '--initial-branch=main');
  git(checkout, 'config', 'user.email', 'test@example.test');
  git(checkout, 'config', 'user.name', 'test');
  copyFileSync(
    join(repo, 'scripts/release-image-tag.sh'),
    join(checkout, 'scripts/release-image-tag.sh'),
  );
  const old = commit(checkout, '0.2.0');
  git(checkout, 'tag', 'v0.2.0');
  const release = commit(checkout, '0.3.0');
  git(checkout, 'tag', 'v0.3.0');
  writeFileSync(join(checkout, 'other.txt'), 'later\n');
  const after = commit(checkout, '0.3.0');

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
echo "gh $*" >> "$STUB_LOG"
[ "\${GH_FAIL:-0}" = "1" ] && { echo "error connecting to api.github.com" >&2; exit 1; }
echo "\${LATEST:-v0.3.0}"
`,
  );
  chmodSync(gh, 0o755);
  const docker = join(bin, 'docker');
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
exit "\${DOCKER_EXIT:-0}"
`,
  );
  chmodSync(docker, 0o755);
  return { root, checkout, commits: { old, release, after }, log: join(root, 'stub.log') };
};

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly string[];
}

const run = (
  place: Sandbox,
  options: {
    readonly at?: string;
    readonly tag?: string;
    readonly env?: Record<string, string>;
  } = {},
): Outcome => {
  if (options.at !== undefined) git(place.checkout, 'checkout', '--quiet', options.at);
  const result = Bun.spawnSync(
    ['bash', 'scripts/release-image-tag.sh', ...(options.tag === undefined ? [] : [options.tag])],
    {
      cwd: place.checkout,
      stderr: 'pipe',
      stdout: 'pipe',
      env: {
        ...quiet,
        PATH: `${join(place.root, 'bin')}:${process.env['PATH'] ?? ''}`,
        HOME: place.root,
        STUB_LOG: place.log,
        IMAGE,
        GH_TOKEN: 'token',
        ...options.env,
      },
    },
  );
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    calls: existsSync(place.log) ? readFileSync(place.log, 'utf8').trim().split('\n') : [],
  };
};

const tagged = (outcome: Outcome): readonly string[] =>
  outcome.calls.filter((call) => call.startsWith('docker buildx imagetools create'));

describe('after release publication, the commit checked out', () => {
  test('the latest release: its tested image is named by its version and `release`', () => {
    const place = sandbox();
    const outcome = run(place, { at: place.commits.release });
    expect(outcome.code).toBe(0);
    expect(tagged(outcome)).toEqual([
      `docker buildx imagetools create --tag ${IMAGE}:v0.3.0 --tag ${IMAGE}:release ${IMAGE}:sha-${place.commits.release}`,
    ]);
  });

  test('a commit that is no release — most merges — changes nothing and asks nobody', () => {
    const place = sandbox();
    const outcome = run(place, { at: place.commits.after });
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('is not the release v0.3.0; nothing to tag');
    expect(outcome.calls).toEqual([]);
  });
});

describe('by hand, a release by its tag', () => {
  test('the latest one is named, from any checkout', () => {
    const place = sandbox();
    const outcome = run(place, { at: place.commits.after, tag: 'v0.3.0' });
    expect(outcome.code).toBe(0);
    expect(tagged(outcome)).toHaveLength(1);
    expect(tagged(outcome)[0]).toEndWith(`${IMAGE}:sha-${place.commits.release}`);
  });

  test('an older one is refused: `release` only moves forward', () => {
    const place = sandbox();
    const outcome = run(place, { tag: 'v0.2.0' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('v0.2.0 is not the latest release (v0.3.0)');
    expect(tagged(outcome)).toEqual([]);
  });

  test('a tag that is not a plain version, or that does not exist, is refused', () => {
    const place = sandbox();
    expect(run(place, { tag: 'main' }).stderr).toContain('give a release tag like v1.2.3');
    const missing = run(place, { tag: 'v9.9.9' });
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('there is no tag v9.9.9');
    expect(tagged(missing)).toEqual([]);
  });
});

describe('what stops it', () => {
  test('a GitHub that cannot be asked is not taken to mean this is the latest', () => {
    const place = sandbox();
    const outcome = run(place, { at: place.commits.release, env: { GH_FAIL: '1' } });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('cannot tell which release is the latest');
    expect(tagged(outcome)).toEqual([]);
  });

  test('an image that was never published says so', () => {
    const place = sandbox();
    const outcome = run(place, { at: place.commits.release, env: { DOCKER_EXIT: '1' } });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('was its image published?');
  });

  test('without the image or a token', () => {
    const place = sandbox();
    expect(run(place, { env: { IMAGE: '' } }).stderr).toContain('IMAGE is unset');
    expect(run(place, { env: { GH_TOKEN: '' } }).stderr).toContain('GH_TOKEN is unset');
  });
});
