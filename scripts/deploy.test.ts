/**
 * Deploying a merged commit to the server (`scripts/deploy.sh`, D-185).
 *
 * Run, not read: each case is a repository and a deployment directory made for the purpose, with
 * `docker`, the backup, the restore and the smoke test replaced by stubs that write what they were
 * asked to a log and answer as the case says. So "a failed build changes nothing" and "a failed start
 * restores the backup and puts the old image back" are behaviour this file watches happen — no
 * daemon, no database, no network.
 *
 * The `docker` stub is not forgiving on purpose. `compose up` records the image and the release the
 * env file and the `current` link name at the moment it is called, and `inspect` answers with the
 * commit of THAT image: a deploy that starts the stack before it has switched, or that never switches,
 * reports the old commit and fails here, as it would on the server.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const repo = join(import.meta.dir, '..');
const OLD = 'a'.repeat(8);
const OLD_REVISION = '0'.repeat(40);
const BACKUP = 'purlay-20261026T000000Z';

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});

/** Git that reads no configuration of the machine's: a signing key or a hook there is not ours. */
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

const stub = (path: string, body: string): void => {
  writeFileSync(
    path,
    `#!/usr/bin/env bash\nset -u\necho "$(basename "$0") $*" >> "$STUB_LOG"\n${body}\n`,
  );
  chmodSync(path, 0o755);
};

/**
 * The `docker` stub. `__ROOT__` is the sandbox and `__D__{` is bash's `${`, which a template literal
 * would read as its own.
 */
const DOCKER = String.raw`
case "$1" in
  info) exit "__D__{DOCKER_INFO_EXIT:-0}" ;;
  build)
    cat "$DEPLOY_ROOT/.deploy.lock/pid" > __ROOT__/lock-during-build 2>/dev/null
    while [ $# -gt 0 ]; do
      case "$1" in
        --label) case "$2" in org.opencontainers.image.revision=*) echo "__D__{2#*=}" > __ROOT__/built-revision ;; esac ;;
        -t) echo "$2" > __ROOT__/built-tag ;;
      esac
      shift
    done
    exit "__D__{BUILD_EXIT:-0}" ;;
  tag) exit "__D__{TAG_EXIT:-0}" ;;
  image) exit 0 ;;
  inspect)
    built="$(cat __ROOT__/built-revision 2>/dev/null || echo none)"
    image="$(cat __ROOT__/last-up-image 2>/dev/null || echo none)"
    case "$image" in
      *"sha-__D__{built:0:8}") seen="$built" ;;
      *) seen="0000000000000000000000000000000000000000" ;;
    esac
    container="__D__{@: -1}"
    variable="REVISION_SEEN_$(echo "__D__{container#container-}" | tr a-z A-Z)"
    if [ -n "__D__{!variable:-}" ]; then seen="__D__{!variable}"; fi
    echo "$seen"
    exit 0 ;;
  compose)
    shift
    files=""; envfile=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -f) files="$files $2"; shift 2 ;;
        --env-file) envfile="$2"; shift 2 ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    case "$1" in
      up)
        n=$(( $(cat __ROOT__/up-count 2>/dev/null || echo 0) + 1 ))
        echo "$n" > __ROOT__/up-count
        image="$(sed -n 's/^PURLAY_IMAGE=//p' "$envfile")"
        echo "$image" > __ROOT__/last-up-image
        printf '%s\n%s\n%s\n' "$image" "$(readlink "$DEPLOY_ROOT/current")" "$files | $*" > "__ROOT__/up-$n"
        if [ "$n" = 1 ] && [ -n "__D__{UP_HANG:-}" ]; then sleep "$UP_HANG"; fi
        if [ "$n" -le "__D__{UP_FAILS:-0}" ]; then exit 1; fi
        exit 0 ;;
      ps)
        service="$3"
        variable="PS_EMPTY_$(echo "$service" | tr a-z A-Z)"
        if [ -n "__D__{!variable:-}" ]; then exit 0; fi
        echo "container-$service"; exit 0 ;;
      stop) exit "__D__{STOP_EXIT:-0}" ;;
    esac
    exit 0 ;;
esac
exit 97
`;

interface Sandbox {
  readonly root: string;
  /** The checkout the workflow runs in, at the commit to deploy. */
  readonly checkout: string;
  /** What the server keeps: releases, backups, the env file, the history. */
  readonly deployment: string;
  readonly sha: string;
  readonly short: string;
  readonly log: string;
}

const COMPOSE = 'services: {}\n';

const release = (deployment: string, name: string, caddyfile: string): void => {
  mkdirSync(join(deployment, 'releases', name, 'docker'), { recursive: true });
  writeFileSync(join(deployment, 'releases', name, 'docker-compose.production.yml'), COMPOSE);
  writeFileSync(join(deployment, 'releases', name, 'docker/Caddyfile'), caddyfile);
};

/** A checkout at one commit, and a deployment that is running release `aaaaaaaa`. */
const sandbox = (
  options: { readonly dockerChanged?: boolean; readonly running?: 'old' | 'same-commit' } = {},
): Sandbox => {
  // Resolved: the script names paths as the system does (`/private/var`, not `/var`, on a Mac).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-')));
  sandboxes.push(root);
  const checkout = join(root, 'checkout');
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  mkdirSync(join(checkout, 'docker'));
  git(checkout, 'init', '--quiet', '--initial-branch=main');
  git(checkout, 'config', 'user.email', 'test@example.test');
  git(checkout, 'config', 'user.name', 'test');
  copyFileSync(join(repo, 'scripts/deploy.sh'), join(checkout, 'scripts/deploy.sh'));
  copyFileSync(join(repo, 'scripts/ops-common.sh'), join(checkout, 'scripts/ops-common.sh'));
  stub(join(checkout, 'scripts/image-smoke.sh'), 'exit "${SMOKE_EXIT:-0}"');
  stub(
    join(checkout, 'scripts/backup.sh'),
    `echo "COMPOSE_FILE=$COMPOSE_FILE ENV_FILE=$ENV_FILE" >> "$STUB_LOG"
if [ "\${BACKUP_EXIT:-0}" != 0 ]; then exit "$BACKUP_EXIT"; fi
mkdir -p "$1/${BACKUP}"
if [ -z "\${BACKUP_NO_DUMP:-}" ]; then touch "$1/${BACKUP}/database.dump"; fi
echo "database: dumping"
echo "$1/${BACKUP}"`,
  );
  stub(
    join(checkout, 'scripts/restore.sh'),
    `echo "COMPOSE_FILE=$COMPOSE_FILE ENV_FILE=$ENV_FILE" >> "$STUB_LOG"\nexit "\${RESTORE_EXIT:-0}"`,
  );
  writeFileSync(join(checkout, 'docker-compose.production.yml'), COMPOSE);
  writeFileSync(join(checkout, 'docker/Caddyfile'), options.dockerChanged ? 'new\n' : 'same\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'one');
  const sha = git(checkout, 'rev-parse', 'HEAD');
  const short = sha.slice(0, 8);

  const deployment = join(root, 'deployment');
  mkdirSync(deployment);
  const running = options.running === 'same-commit' ? short : OLD;
  release(
    deployment,
    running,
    options.running === 'same-commit' && options.dockerChanged === true ? 'new\n' : 'same\n',
  );
  symlinkSync(join('releases', running), join(deployment, 'current'));
  writeFileSync(
    join(deployment, 'production.env'),
    `APP_URL=https://example.test\nPURLAY_IMAGE=purlay-api:sha-${running}\nPOSTGRES_PASSWORD=secret\n`,
  );
  chmodSync(join(deployment, 'production.env'), 0o600);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  stub(join(bin, 'docker'), DOCKER.replaceAll('__ROOT__', root).replaceAll('__D__{', '${'));
  return { root, checkout, deployment, sha, short, log: join(root, 'stub.log') };
};

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** What the stubs were asked, in order. */
  readonly calls: readonly string[];
}

const environment = (place: Sandbox, env: Record<string, string>): Record<string, string> => ({
  ...quiet,
  PATH: `${join(place.root, 'bin')}:${process.env['PATH'] ?? ''}`,
  HOME: place.root,
  STUB_LOG: place.log,
  DEPLOY_ROOT: place.deployment,
  ...env,
});

const callsOf = (place: Sandbox): readonly string[] =>
  existsSync(place.log) ? readFileSync(place.log, 'utf8').trim().split('\n') : [];

const deploy = (
  place: Sandbox,
  env: Record<string, string> = {},
  args: readonly string[] = [place.sha],
): Outcome => {
  const run = Bun.spawnSync(['bash', 'scripts/deploy.sh', ...args], {
    cwd: place.checkout,
    stderr: 'pipe',
    stdout: 'pipe',
    env: environment(place, env),
  });
  return {
    code: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
    calls: callsOf(place),
  };
};

const called = (outcome: Outcome, fragment: string): boolean =>
  outcome.calls.some((call) => call.includes(fragment));
const indexOfCall = (outcome: Outcome, fragment: string): number =>
  outcome.calls.findIndex((call) => call.includes(fragment));
const callsWith = (outcome: Outcome, fragment: string): readonly string[] =>
  outcome.calls.filter((call) => call.includes(fragment));

const envFile = (place: Sandbox): string =>
  readFileSync(join(place.deployment, 'production.env'), 'utf8');
const current = (place: Sandbox): string =>
  basename(readlinkSync(join(place.deployment, 'current')));
const history = (place: Sandbox): string => {
  const path = join(place.deployment, 'deploys.log');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
};
const mode = (path: string): number => statSync(path).mode & 0o777;
/** What the n-th `compose up` saw: the image, the release `current` named, and the command. */
const up = (place: Sandbox, n: number): { image: string; release: string; command: string } => {
  const [image = '', named = '', command = ''] = readFileSync(
    join(place.root, `up-${String(n)}`),
    'utf8',
  )
    .trim()
    .split('\n');
  return { image, release: named, command };
};

/** Nothing the running site depends on was touched. */
const unchanged = (place: Sandbox): void => {
  expect(envFile(place)).toContain(`PURLAY_IMAGE=purlay-api:sha-${OLD}`);
  expect(current(place)).toBe(OLD);
  expect(existsSync(join(place.deployment, '.switching'))).toBe(false);
};

describe('what it refuses to deploy', () => {
  test('without a deployment directory to deploy into', () => {
    const place = sandbox();
    const outcome = deploy(place, { DEPLOY_ROOT: '' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('DEPLOY_ROOT is unset');
    expect(outcome.calls).toEqual([]);
  });

  test('a commit that is not the checkout', () => {
    const place = sandbox();
    const outcome = deploy(place, {}, ['b'.repeat(40)]);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('is not the commit checked out');
    expect(outcome.calls).toEqual([]);
    unchanged(place);
  });

  test('anything but a full commit hash', () => {
    const place = sandbox();
    const outcome = deploy(place, {}, ['main']);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('a full 40-digit commit hash');
  });

  test('a checkout with changes in it: what runs is what was merged', () => {
    const place = sandbox();
    writeFileSync(join(place.checkout, 'local.txt'), 'not merged');
    const outcome = deploy(place);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('the working tree is not clean');
    expect(outcome.calls).toEqual([]);
  });

  test('a deployment that is not running a release yet, which has nothing to back up', () => {
    const place = sandbox();
    rmSync(join(place.deployment, 'current'));
    const outcome = deploy(place);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('no release is running');
    expect(outcome.calls).toEqual([]);
  });

  test('a running release that is not under releases/, which a rollback could not return to', () => {
    const place = sandbox();
    mkdirSync(join(place.root, 'elsewhere/docker'), { recursive: true });
    writeFileSync(join(place.root, 'elsewhere/docker-compose.production.yml'), COMPOSE);
    rmSync(join(place.deployment, 'current'));
    symlinkSync(join(place.root, 'elsewhere'), join(place.deployment, 'current'));
    const outcome = deploy(place);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('not at a directory under');
    expect(outcome.calls).toEqual([]);
  });

  test('an env file with no image to replace', () => {
    const place = sandbox();
    writeFileSync(join(place.deployment, 'production.env'), 'APP_URL=https://example.test\n');
    const outcome = deploy(place);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('has no PURLAY_IMAGE');
    expect(outcome.calls).toEqual([]);
  });

  test.each([
    ['KEEP', 'abc'],
    ['KEEP', '-1'],
    ['WAIT_TIMEOUT', 'soon'],
  ])('%s=%s, before anything is done', (name, value) => {
    const outcome = deploy(sandbox(), { [name]: value });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain(`${name} must be a number`);
    expect(outcome.calls).toEqual([]);
  });

  test('no Docker daemon, before anything is backed up', () => {
    const place = sandbox();
    const outcome = deploy(place, { DOCKER_INFO_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('Docker does not answer');
    expect(called(outcome, 'backup.sh')).toBe(false);
  });

  test('a deploy that an earlier one cut off after it switched, until someone has looked', () => {
    const place = sandbox();
    writeFileSync(join(place.deployment, '.switching'), 'previous=aaaaaaaa new=bbbbbbbb backup=/x');
    const outcome = deploy(place);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('cut off after it switched');
    expect(outcome.stderr).toContain('previous=aaaaaaaa');
    expect(outcome.calls).toEqual([]);
    expect(existsSync(join(place.deployment, '.switching'))).toBe(true);
  });
});

describe('one deploy at a time', () => {
  test('a live one is not disturbed, and its lock is left as it was', () => {
    const place = sandbox();
    const lock = join(place.deployment, '.deploy.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), String(process.pid));
    const outcome = deploy(place);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('another deploy is running');
    expect(outcome.calls).toEqual([]);
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(String(process.pid));
  });

  test('a dead one does not block the next', () => {
    const place = sandbox();
    const lock = join(place.deployment, '.deploy.lock');
    mkdirSync(lock);
    // A process that has exited and been reaped: its pid answers to nobody.
    writeFileSync(join(lock, 'pid'), String(Bun.spawnSync(['true']).pid));
    const outcome = deploy(place);
    expect(outcome.code).toBe(0);
    expect(outcome.stderr).toContain('stale lock');
    expect(existsSync(lock)).toBe(false);
  });

  test('holds the lock while it works, and lets it go when it is done or fails', () => {
    const place = sandbox();
    expect(deploy(place).code).toBe(0);
    expect(readFileSync(join(place.root, 'lock-during-build'), 'utf8').trim()).toMatch(/^\d+$/);
    expect(existsSync(join(place.deployment, '.deploy.lock'))).toBe(false);
    const failed = sandbox();
    deploy(failed, { BUILD_EXIT: '1' });
    expect(existsSync(join(failed.deployment, '.deploy.lock'))).toBe(false);
  });
});

describe('a failure before the switch changes nothing and restores nothing', () => {
  test('a build that fails: no smoke test, no backup, the running site untouched', () => {
    const place = sandbox();
    const outcome = deploy(place, { BUILD_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('the image did not build');
    expect(called(outcome, 'image-smoke.sh')).toBe(false);
    expect(called(outcome, 'backup.sh')).toBe(false);
    expect(called(outcome, 'compose')).toBe(false);
    expect(called(outcome, 'restore.sh')).toBe(false);
    unchanged(place);
    expect(history(place)).toContain('failed-before-switch');
    expect(existsSync(join(place.deployment, 'releases', place.short))).toBe(false);
  });

  test('a smoke test that fails: no backup is made for an image that will not be used', () => {
    const place = sandbox();
    const outcome = deploy(place, { SMOKE_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('the smoke test failed');
    expect(called(outcome, 'backup.sh')).toBe(false);
    expect(called(outcome, ' up ')).toBe(false);
    expect(called(outcome, 'restore.sh')).toBe(false);
    unchanged(place);
  });

  test('a backup that fails: the image was built and tried, and still nothing is switched', () => {
    const place = sandbox();
    const outcome = deploy(place, { BACKUP_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('the backup failed');
    expect(called(outcome, 'docker tag')).toBe(false);
    expect(called(outcome, ' up ')).toBe(false);
    expect(called(outcome, 'restore.sh')).toBe(false);
    unchanged(place);
    expect(history(place)).toContain('failed-before-switch');
  });

  test('a backup that says it worked and holds no dump is not a backup', () => {
    const place = sandbox();
    const outcome = deploy(place, { BACKUP_NO_DUMP: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('no database.dump');
    expect(called(outcome, ' up ')).toBe(false);
    unchanged(place);
  });

  test('an image that cannot be given its name: the files are put back, nothing is restored', () => {
    const place = sandbox();
    const outcome = deploy(place, { TAG_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('the files could not be switched');
    expect(called(outcome, ' up ')).toBe(false);
    expect(called(outcome, 'restore.sh')).toBe(false);
    unchanged(place);
  });

  test('a deploy of the commit that is running: a build that fails does not remove it', () => {
    const place = sandbox({ running: 'same-commit' });
    const outcome = deploy(place, { BUILD_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(current(place)).toBe(place.short);
    expect(
      existsSync(join(place.deployment, 'releases', place.short, 'docker-compose.production.yml')),
    ).toBe(true);
  });
});

describe('a failure after the switch goes back the way the runbook says', () => {
  test('a stack that does not start: stop the API, restore the database alone, put the old ones back, start', () => {
    const place = sandbox();
    const outcome = deploy(place, { UP_FAILS: '1' });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('rolled back');
    const stop = indexOfCall(outcome, 'stop api scheduler');
    const restore = indexOfCall(outcome, 'restore.sh');
    expect(stop).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(stop);
    expect(outcome.calls[indexOfCall(outcome, 'restore.sh') - 1] ?? '').not.toContain('failed');
    // The first start saw the new image and release; the second, after the restore, the old ones.
    expect(up(place, 1).image).toBe(`purlay-api:sha-${place.short}`);
    expect(up(place, 1).release).toBe(`releases/${place.short}`);
    expect(up(place, 2).image).toBe(`purlay-api:sha-${OLD}`);
    expect(up(place, 2).release).toBe(`releases/${OLD}`);
    const starts = outcome.calls
      .map((call, index) => ({ call, index }))
      .filter(({ call }) => call.includes(' up '));
    expect(starts).toHaveLength(2);
    expect(starts[1]?.index ?? 0).toBeGreaterThan(restore);
    unchanged(place);
    expect(history(place)).toContain(`rolled-back ${OLD}`);
  });

  test('the restore is the database alone, from the backup just taken, on the same stack and env', () => {
    const place = sandbox();
    const outcome = deploy(place, { UP_FAILS: '1' });
    const at = indexOfCall(outcome, 'restore.sh');
    const environmentLine = outcome.calls[at + 1] ?? '';
    expect(environmentLine).toContain('docker-compose.production.yml');
    expect(environmentLine).toContain(`ENV_FILE=${join(place.deployment, 'production.env')}`);
    expect(outcome.calls[at]).toContain(BACKUP);
    expect(outcome.calls[at]).toContain('--database purlay --replace --no-bucket');
  });

  test('a stack that starts the wrong commit is a failure, not a success', () => {
    const place = sandbox();
    const outcome = deploy(place, { REVISION_SEEN_API: 'c'.repeat(40) });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain(`api is running commit '${'c'.repeat(40)}'`);
    expect(called(outcome, 'restore.sh')).toBe(true);
    unchanged(place);
  });

  test('a scheduler that is the wrong commit, or not running at all, is a failure too', () => {
    const wrong = deploy(sandbox(), { REVISION_SEEN_SCHEDULER: OLD_REVISION });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr).toContain('scheduler is running commit');
    const missing = deploy(sandbox(), { PS_EMPTY_SCHEDULER: '1' });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('scheduler is not running');
  });

  test('the way back recreates the services too when the files they mount had changed', () => {
    const place = sandbox({ dockerChanged: true });
    const outcome = deploy(place, { UP_FAILS: '1' });
    expect(outcome.code).toBe(1);
    expect(up(place, 1).command).toContain('--force-recreate');
    expect(up(place, 2).command).toContain('--force-recreate');
  });

  test('a stop that fails does not go on to restore over a running API', () => {
    const place = sandbox();
    const outcome = deploy(place, { UP_FAILS: '1', STOP_EXIT: '1' });
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain('ROLLBACK FAILED');
    expect(called(outcome, 'restore.sh')).toBe(false);
    expect(history(place)).toContain('rollback-failed');
  });

  test('a restore that fails: said loudly, with the backup that holds the data, and the next deploy is held', () => {
    const place = sandbox();
    const outcome = deploy(place, { UP_FAILS: '1', RESTORE_EXIT: '1' });
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain('ROLLBACK FAILED');
    expect(outcome.stderr).toContain(BACKUP);
    expect(history(place)).toContain('rollback-failed');
    expect(existsSync(join(place.deployment, '.switching'))).toBe(true);
    expect(deploy(place).stderr).toContain('cut off after it switched');
  });

  test('an old stack that does not start again is a failed rollback, not a rolled back one', () => {
    const place = sandbox();
    const outcome = deploy(place, { UP_FAILS: '2' });
    expect(outcome.code).toBe(2);
    expect(outcome.stderr).toContain('ROLLBACK FAILED');
    expect(outcome.stderr).not.toContain('rolled back to');
    expect(history(place)).toContain('rollback-failed');
  });

  test('told to stop after the switch, it goes back instead of leaving the site half switched', async () => {
    const place = sandbox();
    const child = Bun.spawn(['bash', 'scripts/deploy.sh', place.sha], {
      cwd: place.checkout,
      stdout: 'pipe',
      stderr: 'pipe',
      env: environment(place, { UP_HANG: '2' }),
    });
    for (let waited = 0; waited < 100 && !existsSync(join(place.root, 'up-1')); waited += 1) {
      await Bun.sleep(50);
    }
    expect(existsSync(join(place.root, 'up-1'))).toBe(true);
    child.kill('SIGTERM');
    const code = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect(code).toBe(1);
    expect(stderr).toContain('told to stop');
    expect(stderr).toContain('rolled back');
    expect(callsOf(place).some((call) => call.includes('restore.sh'))).toBe(true);
    unchanged(place);
  });
});

describe('a deploy', () => {
  test('builds once, tries that build, backs up, and only then gives it its name and starts it', () => {
    const place = sandbox();
    const outcome = deploy(place);
    expect(outcome.code).toBe(0);
    const order = ['docker build', 'image-smoke.sh', 'backup.sh', 'docker tag', ' up '];
    const positions = order.map((fragment) => indexOfCall(outcome, fragment));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(callsWith(outcome, 'docker build')).toHaveLength(1);
    const build = callsWith(outcome, 'docker build')[0] ?? '';
    expect(build).toContain(`org.opencontainers.image.revision=${place.sha}`);
    expect(build).toContain(`-t purlay-api:candidate-${place.short}`);
    expect(outcome.calls[indexOfCall(outcome, 'image-smoke.sh')]).toContain(
      `purlay-api:candidate-${place.short}`,
    );
    expect(outcome.calls[indexOfCall(outcome, 'docker tag')]).toContain(
      `purlay-api:candidate-${place.short} purlay-api:sha-${place.short}`,
    );
    expect(called(outcome, 'restore.sh')).toBe(false);
    expect(outcome.stdout).toContain(`deployed ${place.short}`);
  });

  test('starts the stack on the new image and the new release, and waits for it to be healthy', () => {
    const place = sandbox();
    const outcome = deploy(place);
    expect(outcome.code).toBe(0);
    expect(up(place, 1).image).toBe(`purlay-api:sha-${place.short}`);
    expect(up(place, 1).release).toBe(`releases/${place.short}`);
    expect(up(place, 1).command).toContain('up -d --wait --wait-timeout 900');
    expect(up(place, 1).command).not.toContain('--force-recreate');
    expect(callsWith(outcome, ' up ')).toHaveLength(1);
  });

  test('the wait is bounded, and the bound is the one asked for', () => {
    const place = sandbox();
    deploy(place, { WAIT_TIMEOUT: '120' });
    expect(up(place, 1).command).toContain('--wait-timeout 120');
  });

  test('names the image by the commit, never by a moving word', () => {
    const place = sandbox();
    const outcome = deploy(place);
    expect(envFile(place)).toContain(`PURLAY_IMAGE=purlay-api:sha-${place.short}`);
    expect(outcome.calls.join('\n')).not.toContain('latest');
  });

  test('says what the backup was taken of, and with which env', () => {
    const place = sandbox();
    const outcome = deploy(place);
    const backupEnv = outcome.calls[indexOfCall(outcome, 'backup.sh') + 1] ?? '';
    expect(backupEnv).toContain(
      `COMPOSE_FILE=${join(place.deployment, 'current')}/docker-compose.production.yml`,
    );
    expect(backupEnv).toContain(`ENV_FILE=${join(place.deployment, 'production.env')}`);
  });

  test('switches the files and leaves no half-written ones, no marker, and the secrets as private as they were', () => {
    const place = sandbox();
    deploy(place);
    expect(current(place)).toBe(place.short);
    expect(envFile(place)).toContain('POSTGRES_PASSWORD=secret');
    expect(existsSync(join(place.deployment, 'production.env.new'))).toBe(false);
    expect(existsSync(join(place.deployment, '.switching'))).toBe(false);
    expect(mode(join(place.deployment, 'production.env'))).toBe(0o600);
    expect(mode(join(place.deployment, 'production.env.prev'))).toBe(0o600);
    expect(readFileSync(join(place.deployment, 'production.env.prev'), 'utf8')).toContain(
      `PURLAY_IMAGE=purlay-api:sha-${OLD}`,
    );
    expect(history(place)).toContain(`deployed ${OLD} -> ${place.short}`);
    expect(history(place)).toContain(`was=purlay-api:sha-${OLD}`);
  });

  test('recreates the services only when a file they mount has changed', () => {
    const same = sandbox();
    deploy(same);
    expect(up(same, 1).command).not.toContain('--force-recreate');
    const changed = sandbox({ dockerChanged: true });
    deploy(changed);
    expect(up(changed, 1).command).toContain('--force-recreate');
  });

  test('uses the overrides the server keeps, in order, for the start and for the way back', () => {
    const place = sandbox();
    writeFileSync(join(place.deployment, 'one.yml'), 'services: {}\n');
    writeFileSync(join(place.deployment, 'two.yml'), 'services: {}\n');
    const overrides = `${join(place.deployment, 'one.yml')} ${join(place.deployment, 'two.yml')}`;
    const outcome = deploy(place, { COMPOSE_OVERRIDES: overrides, UP_FAILS: '1' });
    for (const n of [1, 2]) {
      const files = up(place, n).command.split(' | ')[0] ?? '';
      expect(files.indexOf('one.yml')).toBeGreaterThan(-1);
      expect(files.indexOf('two.yml')).toBeGreaterThan(files.indexOf('one.yml'));
    }
    expect(callsWith(outcome, 'stop api scheduler')[0]).toContain('two.yml');
  });

  test('deploys the commit that is already running without exporting it over itself', () => {
    const place = sandbox({ running: 'same-commit' });
    const outcome = deploy(place);
    expect(outcome.code).toBe(0);
    expect(current(place)).toBe(place.short);
    expect(
      existsSync(join(place.deployment, 'releases', place.short, 'docker-compose.production.yml')),
    ).toBe(true);
    expect(history(place)).toContain(`deployed ${place.short} -> ${place.short}`);
  });
});

describe('what it forgets', () => {
  const age = (path: string, days: number): void => {
    const when = new Date(Date.now() - days * 86_400_000);
    utimesSync(path, when, when);
  };

  test('every release but the running one and the one before it, when none is kept', () => {
    const place = sandbox();
    for (const name of ['1111111a', '2222222b', '3333333c']) {
      release(place.deployment, name, 'same\n');
    }
    const outcome = deploy(place, { KEEP: '0' });
    expect(outcome.code).toBe(0);
    expect(readdirSync(join(place.deployment, 'releases')).sort()).toEqual(
      [OLD, place.short].sort(),
    );
  });

  test('the newest ones it is told to keep, by age, and removes the images of the others', () => {
    const place = sandbox();
    const names = ['1111111a', '2222222b', '3333333c', '4444444d'];
    for (const [index, name] of names.entries()) {
      release(place.deployment, name, 'same\n');
      age(join(place.deployment, 'releases', name), 40 - index * 10); // 1111111a oldest, 4444444d newest
    }
    age(join(place.deployment, 'releases', OLD), 60);
    const outcome = deploy(place, { KEEP: '2' });
    expect(outcome.code).toBe(0);
    // The new release and the newest of what was there are kept; so is the one that was running.
    expect(readdirSync(join(place.deployment, 'releases')).sort()).toEqual(
      [OLD, place.short, '4444444d'].sort(),
    );
    for (const gone of ['1111111a', '2222222b', '3333333c']) {
      expect(called(outcome, `docker image rm purlay-api:sha-${gone}`)).toBe(true);
    }
    expect(called(outcome, 'docker image rm purlay-api:sha-4444444d')).toBe(false);
    expect(called(outcome, `docker image rm purlay-api:sha-${place.short}`)).toBe(false);
  });

  test('old backups beyond the ones kept, newest first', () => {
    const place = sandbox();
    mkdirSync(join(place.deployment, 'backups'));
    const names = ['purlay-20260101T000000Z', 'purlay-20260102T000000Z', 'purlay-20260103T000000Z'];
    for (const [index, name] of names.entries()) {
      mkdirSync(join(place.deployment, 'backups', name));
      age(join(place.deployment, 'backups', name), 30 - index);
    }
    deploy(place, { KEEP: '2' });
    const left = readdirSync(join(place.deployment, 'backups')).sort();
    expect(left).toContain(BACKUP);
    expect(left).toContain('purlay-20260103T000000Z');
    expect(left).not.toContain('purlay-20260101T000000Z');
  });

  test('nothing that is not a release or a backup of its own', () => {
    const place = sandbox();
    mkdirSync(join(place.deployment, 'releases', 'my notes'));
    mkdirSync(join(place.deployment, 'releases', 'src'));
    const outcome = deploy(place, { KEEP: '0' });
    expect(outcome.code).toBe(0);
    const left = readdirSync(join(place.deployment, 'releases'));
    expect(left).toContain('src');
    expect(left).toContain('my notes');
  });
});
