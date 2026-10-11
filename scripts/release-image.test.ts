/**
 * Publishing the image from a machine, while the pipeline cannot (`scripts/release-image.sh`).
 *
 * The order is the argument: what is released is a merged commit, judged by the gate CI would
 * have run, built once, started the way production starts it, and only then pushed — the
 * image that was tested is the image that is published. The refusals are run, in a repository
 * made for the purpose; the order is read from the script, because the steps after the gate
 * need a registry and a daemon this test must not touch.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');
const script = readFileSync(join(repo, 'scripts/release-image.sh'), 'utf8');
const code = script
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

const GITHUB = 'https://github.com/Acme/Purlay.git';

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): void => {
  const run = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe', stdout: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr.toString()}`);
};

/** A clone of a one-commit origin, with the script in it, and nothing else. */
const sandbox = (): { readonly clone: string; readonly origin: string } => {
  const root = mkdtempSync(join(tmpdir(), 'release-'));
  sandboxes.push(root);
  const origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, 'init', '--quiet', '--initial-branch=main');
  git(origin, 'config', 'user.email', 'test@example.test');
  git(origin, 'config', 'user.name', 'test');
  mkdirSync(join(origin, 'scripts'));
  copyFileSync(join(repo, 'scripts/release-image.sh'), join(origin, 'scripts/release-image.sh'));
  git(origin, 'add', '.');
  git(origin, 'commit', '--quiet', '-m', 'one');
  const clone = join(root, 'clone');
  git(root, 'clone', '--quiet', origin, clone);
  git(clone, 'config', 'user.email', 'test@example.test');
  git(clone, 'config', 'user.name', 'test');
  // Named as a GitHub repository, fetched from the one made here.
  git(clone, 'remote', 'set-url', 'origin', GITHUB);
  git(clone, 'config', `url.${origin}.insteadOf`, GITHUB);
  return { clone, origin };
};

const release = (
  cwd: string,
): { readonly code: number; readonly stderr: string; readonly stdout: string } => {
  const run = Bun.spawnSync(['bash', 'scripts/release-image.sh'], {
    cwd,
    stderr: 'pipe',
    stdout: 'pipe',
    // No database: a run that got past the first refusals stops at the gate, never at a build.
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
  });
  return { code: run.exitCode, stderr: run.stderr.toString(), stdout: run.stdout.toString() };
};

describe('what it refuses to release', () => {
  test('a working tree with changes in it', () => {
    const { clone } = sandbox();
    writeFileSync(join(clone, 'stray.txt'), 'not merged');
    const outcome = release(clone);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('the working tree is not clean');
  });

  test('a commit that is not on origin/main', () => {
    const { clone } = sandbox();
    writeFileSync(join(clone, 'local.txt'), 'committed here only');
    git(clone, 'add', '.');
    git(clone, 'commit', '--quiet', '-m', 'local');
    const outcome = release(clone);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('is not on origin/main');
  });

  test('a remote that does not name a GitHub repository', () => {
    const { clone } = sandbox();
    git(clone, 'remote', 'set-url', 'origin', 'https://example.test/somewhere');
    git(clone, 'config', '--unset', `url.${join(clone, '..', 'origin')}.insteadOf`);
    const outcome = release(clone);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('cannot read owner/name');
  });

  test('without a database, rather than releasing on the unit tests alone', () => {
    const { clone } = sandbox();
    const outcome = release(clone);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('DATABASE_URL is unset');
    // Got as far as naming it: the registry wants the name in lower case.
    expect(outcome.stdout).toContain('as ghcr.io/acme/purlay-api:sha-');
  });
});

describe('the order it does things in', () => {
  const at = (needle: string): number => {
    const index = code.indexOf(needle);
    expect(index, needle).toBeGreaterThan(-1);
    return index;
  };

  test('the gate, then one build, then the smoke test of that build, then the push', () => {
    const gate = at('bun run verify');
    const build = at('docker buildx build');
    const smoke = at('scripts/image-smoke.sh "$TAG"');
    const push = at('docker push "$TAG"');
    expect(gate).toBeLessThan(build);
    expect(build).toBeLessThan(smoke);
    expect(smoke).toBeLessThan(push);
    // Built once: the image smoke-tested is the image pushed.
    expect(code.match(/docker (buildx )?build/g)).toHaveLength(1);
  });

  test("builds for the server's platform unless told otherwise", () => {
    expect(code).toContain('PLATFORM="${PLATFORM:-linux/amd64}"');
    expect(code).toContain('--platform "$PLATFORM"');
  });

  test('names the image by commit and prints a digest, never a moving tag', () => {
    expect(code).toContain('TAG="$IMAGE:sha-$SHA"');
    expect(code).not.toMatch(/:main\b|:latest\b/);
    expect(code).toContain('PURLAY_IMAGE=$DIGEST');
  });
});
