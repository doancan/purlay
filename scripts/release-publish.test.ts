/**
 * Publishing the release a merge made (`scripts/release-publish.sh`, D-185).
 *
 * Run, not read: each case is a checkout with `gh` replaced by a stub that writes what it was
 * asked to a log and answers as the case says. So "a version that is already released is not
 * released again" and "a GitHub that cannot be asked is not taken to mean no" are behaviour this
 * file watches happen — no repository, no network.
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
import { rollChanges } from './release-prepare';

const repo = join(import.meta.dir, '..');

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

const quiet = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

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

const NOTES = `# Purlay v0.1.0 — 2026-10-26

### Added

- **Appearance** — Dark is black now, and Midnight is a theme of its own (D-184)

### Fixed

- **Appearance** — One check box and one radio, drawn the same on every screen (D-182)
`;

interface Sandbox {
  readonly root: string;
  readonly checkout: string;
  readonly sha: string;
  readonly log: string;
  readonly body: string;
  readonly assets: string;
}

const sandbox = (
  options: { readonly version?: string; readonly notes?: boolean } = {},
): Sandbox => {
  const version = options.version ?? '0.1.0';
  const root = mkdtempSync(join(tmpdir(), 'publish-'));
  sandboxes.push(root);
  const checkout = join(root, 'checkout');
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  mkdirSync(join(checkout, 'docs/changelog'), { recursive: true });
  git(checkout, 'init', '--quiet', '--initial-branch=main');
  git(checkout, 'config', 'user.email', 'test@example.test');
  git(checkout, 'config', 'user.name', 'test');
  copyFileSync(
    join(repo, 'scripts/release-publish.sh'),
    join(checkout, 'scripts/release-publish.sh'),
  );
  writeFileSync(
    join(checkout, 'package.json'),
    `{\n  "name": "purlay",\n  "version": "${version}",\n  "private": true\n}\n`,
  );
  if (options.notes !== false)
    writeFileSync(join(checkout, `docs/changelog/v${version}.md`), NOTES);
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'one');
  const sha = git(checkout, 'rev-parse', 'HEAD');

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const body = join(root, 'release-body.md');
  const assets = join(root, 'assets');
  mkdirSync(assets);
  const bun = join(bin, 'bun');
  writeFileSync(
    bun,
    `#!/usr/bin/env bash
set -u
echo "bun $*" >> "$STUB_LOG"
[ "$1 $2" = "run contract:bundle" ] || exit 97
[ "\${BUNDLE_EXIT:-0}" = "0" ] || { echo "the bundle could not be built" >&2; exit "\${BUNDLE_EXIT}"; }
[ "$3" = "--out" ] || exit 98
mkdir -p "$4"
[ "\${BUNDLE_EMPTY:-0}" = "1" ] && exit 0
echo '{"format":1}' > "$4/MANIFEST.json"
echo 'readme' > "$4/README.md"
`,
  );
  chmodSync(bun, 0o755);
  const tar = join(bin, 'tar');
  writeFileSync(
    tar,
    `#!/usr/bin/env bash
[ "\${TAR_FAIL:-0}" = "1" ] && { echo "tar: no space left on device" >&2; exit 2; }
exec /usr/bin/tar "$@"
`,
  );
  chmodSync(tar, 0o755);
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -u
echo "gh $*" >> "$STUB_LOG"
case "$1 $2" in
  "release view")
    case "\${RELEASE_VIEW:-missing}" in
      exists) echo "title: Purlay"; exit 0 ;;
      missing) echo "release not found" >&2; exit 1 ;;
      nogh) echo "gh: command not found" >&2; exit 127 ;;
      *) echo "error connecting to api.github.com" >&2; exit 1 ;;
    esac ;;
  "release create")
    while [ $# -gt 0 ]; do
      if [ "$1" = "--notes-file" ]; then cp "$2" "${body}"; fi
      case "$1" in *.tar.gz|*.sha256) [ -f "$1" ] && cp "$1" "${assets}/" ;; esac
      shift
    done
    exit "\${CREATE_EXIT:-0}" ;;
esac
exit 97
`,
  );
  chmodSync(gh, 0o755);
  return { root, checkout, sha, log: join(root, 'stub.log'), body, assets };
};

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly string[];
}

const publish = (
  place: Sandbox,
  env: Record<string, string> = {},
  args: readonly string[] = [place.sha],
): Outcome => {
  const run = Bun.spawnSync(['bash', 'scripts/release-publish.sh', ...args], {
    cwd: place.checkout,
    stderr: 'pipe',
    stdout: 'pipe',
    env: {
      ...quiet,
      PATH: `${join(place.root, 'bin')}:${process.env['PATH'] ?? ''}`,
      HOME: place.root,
      STUB_LOG: place.log,
      GH_TOKEN: 'token',
      GITHUB_REPOSITORY: 'acme/purlay',
      ...env,
    },
  });
  return {
    code: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
    calls: existsSync(place.log) ? readFileSync(place.log, 'utf8').trim().split('\n') : [],
  };
};

const created = (outcome: Outcome): boolean =>
  outcome.calls.some((call) => call.startsWith('gh release create'));

describe('what it refuses to publish', () => {
  test('anything but a full commit hash', () => {
    const outcome = publish(sandbox(), {}, ['main']);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('a full 40-digit commit hash');
  });

  test('a commit that is not the checkout', () => {
    const outcome = publish(sandbox(), {}, ['b'.repeat(40)]);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('is not the commit checked out');
    expect(outcome.calls).toEqual([]);
  });

  test('without a token or a repository to publish to', () => {
    const noToken = publish(sandbox(), { GH_TOKEN: '' });
    expect(noToken.code).not.toBe(0);
    expect(noToken.stderr).toContain('GH_TOKEN is unset');
    const noRepository = publish(sandbox(), { GITHUB_REPOSITORY: '' });
    expect(noRepository.code).not.toBe(0);
    expect(noRepository.stderr).toContain('GITHUB_REPOSITORY is unset');
  });

  test('a version with no notes: the release PR writes them, so it was not the one merged', () => {
    const outcome = publish(sandbox({ notes: false }));
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('docs/changelog/v0.1.0.md does not exist');
    expect(created(outcome)).toBe(false);
  });

  test.each(['0.1.0-rc', '01.2.3', '1.2'])(
    'a version that is not a plain x.y.z (%s) is never tagged, least of all as the latest',
    (version) => {
      const outcome = publish(sandbox({ version }));
      expect(outcome.code).not.toBe(0);
      expect(outcome.stderr).toContain('no plain x.y.z version');
      expect(outcome.calls).toEqual([]);
    },
  );

  test('a gh that is not installed is not "no such release" either', () => {
    const outcome = publish(sandbox(), { RELEASE_VIEW: 'nogh' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('cannot tell whether v0.1.0 is released');
    expect(created(outcome)).toBe(false);
  });

  test('a GitHub that cannot be asked is not taken to mean there is no release', () => {
    const outcome = publish(sandbox(), { RELEASE_VIEW: 'unreachable' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('cannot tell whether v0.1.0 is released');
    expect(created(outcome)).toBe(false);
  });
});

describe('what it leaves alone', () => {
  test('a version that was never bumped: nothing has been released, and nothing is asked of GitHub', () => {
    const outcome = publish(sandbox({ version: '0.0.0', notes: false }));
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('no release');
    expect(outcome.calls).toEqual([]);
  });

  test('a version that is already released, which every later merge sees', () => {
    const outcome = publish(sandbox(), { RELEASE_VIEW: 'exists' });
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('v0.1.0 is already released');
    expect(created(outcome)).toBe(false);
  });
});

describe('a release', () => {
  test('tags this commit and publishes it as the latest, with the notes the release PR wrote', () => {
    const place = sandbox();
    const outcome = publish(place);
    expect(outcome.code).toBe(0);
    const create = outcome.calls.find((call) => call.startsWith('gh release create')) ?? '';
    expect(create).toContain('v0.1.0');
    expect(create).toContain(`--target ${place.sha}`);
    expect(create).toContain('--latest');
    expect(create).toContain('--title Purlay v0.1.0');
    expect(outcome.stdout).toContain('published v0.1.0');
  });

  test('puts the release notes under a link to the file, without their title', () => {
    const place = sandbox();
    publish(place);
    const body = readFileSync(place.body, 'utf8');
    expect(
      body.startsWith(
        'Full notes: https://github.com/acme/purlay/blob/v0.1.0/docs/changelog/v0.1.0.md\n\n### Added',
      ),
    ).toBe(true);
    expect(body).toContain('- **Appearance** — Dark is black now');
    expect(body).toContain('### Fixed');
    expect(body).not.toContain('# Purlay v0.1.0');
  });

  test('notes that would not fit a release body are replaced by the link alone', () => {
    const place = sandbox();
    const bullets = Array.from(
      { length: 2000 },
      (_, index) =>
        `- **Area** — a line of the notes, number ${String(index)}, long enough to add up (D-1)`,
    ).join('\n');
    writeFileSync(
      join(place.checkout, 'docs/changelog/v0.1.0.md'),
      `# Purlay v0.1.0 — 2026-10-26\n\n### Added\n\n${bullets}\n`,
    );
    git(place.checkout, 'commit', '--quiet', '-am', 'long');
    const sha = git(place.checkout, 'rev-parse', 'HEAD');
    const outcome = publish(place, {}, [sha]);
    expect(outcome.code).toBe(0);
    const body = readFileSync(place.body, 'utf8');
    expect(body.length).toBeLessThan(500);
    expect(body).toContain('too long for a release body');
    expect(body).toContain('blob/v0.1.0/docs/changelog/v0.1.0.md');
  });

  test('publishes what `bun run release` writes: the notes it rolls out of Unreleased', () => {
    const place = sandbox();
    const changes =
      '## Unreleased\n\n### Security\n\n- **Sign-in** — A thing that was hardened (D-179)\n\n---\n';
    writeFileSync(
      join(place.checkout, 'docs/changelog/v0.1.0.md'),
      rollChanges(changes, '0.1.0', '2026-10-26').notes,
    );
    git(place.checkout, 'commit', '--quiet', '-am', 'rolled');
    const sha = git(place.checkout, 'rev-parse', 'HEAD');
    const outcome = publish(place, {}, [sha]);
    expect(outcome.code).toBe(0);
    expect(readFileSync(place.body, 'utf8')).toContain(
      '### Security\n\n- **Sign-in** — A thing that was hardened',
    );
  });

  test('a release GitHub refuses is a failure, not a success', () => {
    const outcome = publish(sandbox(), { CREATE_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('GitHub did not create');
  });
});

describe('the contract bundle attached to a release (D-192)', () => {
  const TARBALL = 'purlay-contract-v0.1.0.tar.gz';
  const DIGEST = 'purlay-contract-v0.1.0.tar.gz.sha256';

  test('is built, packed under one directory named for the tag, and attached with its digest', () => {
    const place = sandbox();
    const outcome = publish(place);
    expect(outcome.code).toBe(0);
    const create = outcome.calls.find((call) => call.startsWith('gh release create')) ?? '';
    expect(create).toContain(TARBALL);
    expect(create).toContain(DIGEST);
    const listing = Bun.spawnSync(['tar', '-tzf', join(place.assets, TARBALL)]).stdout.toString();
    const entries = listing.split('\n').filter((line) => line !== '');
    expect(entries).toContain('purlay-contract-v0.1.0/MANIFEST.json');
    expect(entries).toContain('purlay-contract-v0.1.0/README.md');
  });

  test('has a digest file that verifies the tarball as `sha256sum -c` would read it', () => {
    const place = sandbox();
    publish(place);
    const line = readFileSync(join(place.assets, DIGEST), 'utf8');
    expect(line).toMatch(/^[0-9a-f]{64} {2}purlay-contract-v0\.1\.0\.tar\.gz\n$/);
    const check = Bun.spawnSync(['shasum', '-a', '256', '-c', DIGEST], { cwd: place.assets });
    expect(check.exitCode).toBe(0);
  });

  test('is built before the release exists: a bundle that cannot be built leaves no release behind', () => {
    const outcome = publish(sandbox(), { BUNDLE_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('could not build the contract bundle');
    expect(created(outcome)).toBe(false);
  });

  test('is never an empty one: a build that wrote nothing is refused', () => {
    const outcome = publish(sandbox(), { BUNDLE_EMPTY: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('wrote no files');
    expect(created(outcome)).toBe(false);
  });

  test('is never published unpacked: a tarball that cannot be made leaves no release behind', () => {
    const outcome = publish(sandbox(), { TAR_FAIL: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('could not pack the contract bundle');
    expect(created(outcome)).toBe(false);
  });

  test('is built once the release is known to be needed, and not for one that exists', () => {
    const outcome = publish(sandbox(), { RELEASE_VIEW: 'exists' });
    expect(outcome.calls.some((call) => call.startsWith('bun '))).toBe(false);
  });

  test('is asked of the repository at this version: the one script a checkout has', () => {
    const outcome = publish(sandbox());
    const asked = outcome.calls.filter((call) => call.startsWith('bun '));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/^bun run contract:bundle --out .+\/purlay-contract-v0\.1\.0$/);
  });
});
