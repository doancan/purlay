/**
 * Publishing the image from a machine, while the pipeline cannot (`scripts/release-image.sh`).
 *
 * Run, not read: each case is a repository made for the purpose, cloned, with `docker`, `bun`
 * and the smoke test replaced by stubs that write what they were asked to a log and answer as
 * the case says. So "a failed smoke test never pushes" and "the digest printed is the image
 * that was tested" are behaviour this file watches happen — no daemon, no registry, no network.
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
const GITHUB = 'https://github.com/Acme/Purlay.git';
const IMAGE = 'ghcr.io/acme/purlay-api';
const DIGEST = `sha256:${'a'.repeat(64)}`;

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

/** Git that reads no configuration of the machine's: a signing key or a hook there is not ours. */
const quiet = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

const git = (cwd: string, ...args: string[]): void => {
  const run = Bun.spawnSync(['git', ...args], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
    env: { ...quiet, PATH: process.env['PATH'] ?? '', HOME: cwd },
  });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
};

const stub = (path: string, body: string): void => {
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nset -u\necho "$(basename "$0") $*" >> "$STUB_LOG"\n${body}\n`,
  );
  chmodSync(path, 0o755);
};

interface Sandbox {
  readonly root: string;
  readonly clone: string;
  readonly log: string;
  readonly context: string;
}

/** A clone of a one-commit origin named as a GitHub repository, with stubs on its PATH. */
const sandbox = (): Sandbox => {
  const root = mkdtempSync(join(tmpdir(), 'release-'));
  sandboxes.push(root);
  const origin = join(root, 'origin');
  mkdirSync(join(origin, 'scripts'), { recursive: true });
  git(origin, 'init', '--quiet', '--initial-branch=main');
  git(origin, 'config', 'user.email', 'test@example.test');
  git(origin, 'config', 'user.name', 'test');
  copyFileSync(join(repo, 'scripts/release-image.sh'), join(origin, 'scripts/release-image.sh'));
  stub(join(origin, 'scripts/image-smoke.sh'), 'exit "${SMOKE_EXIT:-0}"');
  writeFileSync(join(origin, 'package.json'), '{ "license": "AGPL-3.0-or-later" }\n');
  writeFileSync(join(origin, '.gitignore'), 'stray.js\n');
  writeFileSync(join(origin, '.dockerignore'), '**/*.test.ts\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '--quiet', '-m', 'one');
  const clone = join(root, 'clone');
  git(root, 'clone', '--quiet', origin, clone);
  git(clone, 'remote', 'set-url', 'origin', GITHUB);
  git(clone, 'config', `url.${origin}.insteadOf`, GITHUB);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  const context = join(root, 'context.tar');
  stub(
    join(bin, 'bun'),
    `if [ "$1" = "run" ] && [ "$2" = "verify" ]; then exit "\${VERIFY_EXIT:-0}"; fi
if [ "$1" = "-e" ]; then echo AGPL-3.0-or-later; exit 0; fi
exit 97`,
  );
  stub(
    join(bin, 'docker'),
    `case "$1 $2" in
  "buildx build") echo "\${@: -1}" > "${context}.path"; tar -cf "${context}" -C "\${@: -1}" . ;;
  "buildx imagetools") echo "\${REGISTRY_DIGEST-${DIGEST}}" ;;
  "push "*) exit "\${PUSH_EXIT:-0}" ;;
  "inspect --format") echo "\${LOCAL_DIGEST-${IMAGE}@${DIGEST}}" ;;
  *) exit 98 ;;
esac`,
  );
  return { root, clone, log: join(root, 'stub.log'), context };
};

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** What the stubs were asked, in order: `docker push …`, `image-smoke.sh …`. */
  readonly calls: readonly string[];
}

const release = (place: Sandbox, env: Record<string, string> = {}): Outcome => {
  const run = Bun.spawnSync(['bash', 'scripts/release-image.sh'], {
    cwd: place.clone,
    stderr: 'pipe',
    stdout: 'pipe',
    env: {
      ...quiet,
      PATH: `${join(place.root, 'bin')}:${process.env['PATH'] ?? ''}`,
      HOME: place.root,
      STUB_LOG: place.log,
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

const WITH_DATABASE = { DATABASE_URL: 'postgres://stub' };
const called = (outcome: Outcome, prefix: string): boolean =>
  outcome.calls.some((call) => call.startsWith(prefix));

describe('what it refuses to release', () => {
  test('a working tree with changes in it', () => {
    const place = sandbox();
    writeFileSync(join(place.clone, 'local.txt'), 'not merged');
    const outcome = release(place, WITH_DATABASE);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('the working tree is not clean');
    expect(outcome.calls).toEqual([]);
  });

  test('a commit that is not on origin/main', () => {
    const place = sandbox();
    writeFileSync(join(place.clone, 'local.txt'), 'committed here only');
    git(place.clone, 'add', '.');
    git(place.clone, '-c', 'user.email=t@e.test', '-c', 'user.name=t', 'commit', '-qm', 'local');
    const outcome = release(place, WITH_DATABASE);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('is not on origin/main');
  });

  test('a remote that does not name a GitHub repository', () => {
    const place = sandbox();
    git(place.clone, 'remote', 'set-url', 'origin', 'https://example.test/somewhere');
    const outcome = release(place, WITH_DATABASE);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('cannot read owner/name');
  });

  test('without a database, rather than releasing on the unit tests alone', () => {
    const outcome = release(sandbox());
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('DATABASE_URL is unset');
    expect(outcome.calls).toEqual([]);
  });
});

describe('a release', () => {
  test('judges, builds once, smoke-tests that build, pushes it, and prints its digest', () => {
    const place = sandbox();
    const outcome = release(place, WITH_DATABASE);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain(`PURLAY_IMAGE=${IMAGE}@${DIGEST}`);
    const tag = /as (\S+) for linux\/amd64/.exec(outcome.stdout)?.[1] ?? '';
    expect(tag).toMatch(new RegExp(`^${IMAGE.replaceAll('.', '\\.')}:sha-[0-9a-f]{40}$`));
    const order = ['bun run verify', 'docker buildx build', 'image-smoke.sh', 'docker push'];
    expect(outcome.calls.filter((call) => order.some((p) => call.startsWith(p)))).toEqual([
      'bun run verify',
      expect.stringContaining(`--platform linux/amd64`) as unknown as string,
      `image-smoke.sh ${tag}`,
      `docker push ${tag}`,
    ]);
    expect(outcome.calls.find((call) => call.startsWith('docker buildx build'))).toContain(
      `--tag ${tag} `,
    );
  });

  test('builds the commit, not the working tree: an ignored file never reaches the image', () => {
    const place = sandbox();
    writeFileSync(join(place.clone, 'stray.js'), 'compiled long ago');
    expect(release(place, WITH_DATABASE).code).toBe(0);
    const entries = Bun.spawnSync(['tar', '-tf', place.context])
      .stdout.toString()
      .split('\n')
      .map((entry) => entry.replace(/^\.\//, ''));
    expect(entries).toContain('scripts/release-image.sh');
    expect(entries).not.toContain('stray.js');
  });

  test('builds from a directory, never a piped archive: only then is .dockerignore applied', () => {
    const place = sandbox();
    expect(release(place, WITH_DATABASE).code).toBe(0);
    const build = readFileSync(`${place.context}.path`, 'utf8').trim();
    expect(build).not.toBe('-');
    const entries = Bun.spawnSync(['tar', '-tf', place.context]).stdout.toString().split('\n');
    expect(entries).toContain('./.dockerignore');
    // Made for the build and gone after it, whatever the outcome.
    expect(existsSync(build)).toBe(false);
  });

  test('names the image from an SSH remote too, in lower case', () => {
    const place = sandbox();
    const ssh = 'git@github.com:Acme/Purlay.git';
    git(place.clone, 'remote', 'set-url', 'origin', ssh);
    git(place.clone, 'config', `url.${join(place.root, 'origin')}.insteadOf`, ssh);
    const outcome = release(place, WITH_DATABASE);
    expect(outcome.stdout).toContain(`as ${IMAGE}:sha-`);
  });

  test('builds for another platform when told to', () => {
    const outcome = release(sandbox(), { ...WITH_DATABASE, PLATFORM: 'linux/arm64' });
    expect(outcome.calls.find((call) => call.startsWith('docker buildx build'))).toContain(
      '--platform linux/arm64',
    );
  });
});

describe('what stops a release part-way', () => {
  test('a gate that fails builds nothing', () => {
    const outcome = release(sandbox(), { ...WITH_DATABASE, VERIFY_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(called(outcome, 'docker')).toBe(false);
  });

  test('a smoke test that fails pushes nothing', () => {
    const outcome = release(sandbox(), { ...WITH_DATABASE, SMOKE_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(called(outcome, 'image-smoke.sh')).toBe(true);
    expect(called(outcome, 'docker push')).toBe(false);
    expect(outcome.stdout).not.toContain('PURLAY_IMAGE');
  });

  test('a registry that names no digest is said, not printed as empty', () => {
    const outcome = release(sandbox(), { ...WITH_DATABASE, REGISTRY_DIGEST: '' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('the registry reports no digest');
    expect(outcome.stdout).not.toContain('PURLAY_IMAGE');
  });

  test('a registry holding another image under the tag is refused', () => {
    const outcome = release(sandbox(), {
      ...WITH_DATABASE,
      LOCAL_DIGEST: `${IMAGE}@sha256:${'b'.repeat(64)}`,
    });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('is not the image that was smoke-tested');
    expect(outcome.stdout).not.toContain('PURLAY_IMAGE');
  });
});
