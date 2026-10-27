/**
 * Point-in-time recovery, the parts a unit test can run without a database (#118, D-202).
 *
 * The whole of it — a base backup, an archive, a loss, a recovery to a noted time, compared row by
 * row — is `scripts/restore-rehearsal.sh`, which needs Docker and runs in its own workflow. What is
 * held here is what fails quietly if nobody looks: the archive command that must never overwrite or
 * half-write a segment, the switch that must add nothing while it is off, the check a cron job runs,
 * the pruning that must never delete on a guess, and that the cron lines the documentation gives
 * resolve in the layout a deploy leaves (the nightly backup once failed silently after the code
 * moved to `releases/<commit>`).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = join(import.meta.dir, '..');
const compose = readFileSync(join(repo, 'docker-compose.production.yml'), 'utf8');
const config = readFileSync(join(repo, 'docs/CONFIG.md'), 'utf8');
const deploy = readFileSync(join(repo, 'scripts/deploy.sh'), 'utf8');

const sandboxes: string[] = [];
afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
});
const sandbox = (prefix: string): string => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
  sandboxes.push(path);
  return path;
};

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}
const run = (
  command: readonly string[],
  env: Record<string, string>,
  cwd: string = repo,
): Outcome => {
  const result = Bun.spawnSync([...command], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};
const BASE_PATH = '/usr/bin:/bin';

// ── the archive command ──────────────────────────────────────────────────────────────────────────

describe('docker/wal-archive.sh, the archive_command', () => {
  const script = join(repo, 'docker/wal-archive.sh');
  const place = (): { archive: string; segments: string } => {
    const root = sandbox('wal-archive');
    const archive = join(root, 'archive');
    const segments = join(root, 'pg_wal');
    mkdirSync(archive);
    mkdirSync(segments);
    return { archive, segments };
  };
  const NAME = '000000010000000000000007';
  const archiveOf = (archive: string, segment: string, name = NAME): Outcome =>
    run(['sh', script, segment, name], { PATH: BASE_PATH, WAL_ARCHIVE_DIR: archive });
  const segment = (segments: string, bytes: number, fill: number, name = NAME): string => {
    const path = join(segments, name);
    writeFileSync(path, Buffer.alloc(bytes, fill));
    return path;
  };

  test('keeps a segment compressed under its own name, readable back byte for byte, with nothing left over', () => {
    const { archive, segments } = place();
    const path = segment(segments, 1 << 20, 7);
    expect(archiveOf(archive, path).code).toBe(0);
    expect(readdirSync(archive)).toEqual([`${NAME}.gz`]);
    const back = Bun.spawnSync(['gzip', '-dc', join(archive, `${NAME}.gz`)]);
    expect(Buffer.from(back.stdout).equals(readFileSync(path))).toBe(true);
  });

  test('archiving the same segment again is success and changes nothing (PostgreSQL retries after a crash)', () => {
    const { archive, segments } = place();
    const path = segment(segments, 4096, 1);
    expect(archiveOf(archive, path).code).toBe(0);
    const before = statSync(join(archive, `${NAME}.gz`)).ino;
    expect(archiveOf(archive, path).code).toBe(0);
    expect(statSync(join(archive, `${NAME}.gz`)).ino).toBe(before);
  });

  test('a different segment under a name already archived is refused, and the archived one is kept', () => {
    const { archive, segments } = place();
    const first = segment(segments, 4096, 1);
    expect(archiveOf(archive, first).code).toBe(0);
    const kept = readFileSync(join(archive, `${NAME}.gz`));
    const other = segment(segments, 4096, 2, 'other');
    const outcome = archiveOf(archive, other);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('refusing to overwrite');
    expect(readFileSync(join(archive, `${NAME}.gz`)).equals(kept)).toBe(true);
    expect(readdirSync(archive)).toEqual([`${NAME}.gz`]);
  });

  test('a missing archive directory, or a segment that is not there, is a failure PostgreSQL will see', () => {
    const { archive, segments } = place();
    const path = segment(segments, 4096, 1);
    expect(archiveOf(join(archive, 'gone'), path).code).not.toBe(0);
    expect(archiveOf(archive, join(segments, 'not-there')).code).not.toBe(0);
    expect(readdirSync(archive)).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)(
    'a directory it cannot write to is a failure that leaves nothing behind',
    () => {
      const { archive, segments } = place();
      const path = segment(segments, 4096, 1);
      chmodSync(archive, 0o500);
      try {
        const outcome = archiveOf(archive, path);
        expect(outcome.code).not.toBe(0);
        expect(readdirSync(archive)).toEqual([]);
      } finally {
        chmodSync(archive, 0o700);
      }
    },
  );

  test.each(['', '../escape', 'a/b', '.hidden'])('refuses the file name %p', (name) => {
    const { archive, segments } = place();
    const path = segment(segments, 4096, 1);
    expect(archiveOf(archive, path, name).code).not.toBe(0);
    expect(readdirSync(archive)).toEqual([]);
  });
});

// ── the switch ───────────────────────────────────────────────────────────────────────────────────

describe('docker/postgres-start.sh, the switch', () => {
  const script = join(repo, 'docker/postgres-start.sh');
  const stubs = (): { bin: string; log: string; archive: string } => {
    const root = sandbox('postgres-start');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'args');
    // The image's entrypoint, which records what it was asked to start; and a chown that is not root's.
    writeFileSync(
      join(bin, 'docker-entrypoint.sh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, 'chown'), '#!/bin/sh\nexit "${CHOWN_EXIT:-0}"\n', { mode: 0o755 });
    const archive = join(root, 'archive');
    mkdirSync(archive);
    return { bin, log, archive };
  };
  const start = (env: Record<string, string>): { outcome: Outcome; args: string[] | null } => {
    const { bin, log, archive } = stubs();
    const outcome = run(['sh', script, 'postgres'], {
      PATH: `${bin}:${BASE_PATH}`,
      WAL_ARCHIVE_DIR: archive,
      ...env,
    });
    return {
      outcome,
      args: existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n') : null,
    };
  };

  test('unset, and off, start the server with exactly what it was given: nothing is added', () => {
    expect(start({}).args).toEqual(['postgres']);
    expect(start({ WAL_ARCHIVE: 'off' }).args).toEqual(['postgres']);
    // Settings that only mean something when on do not leak into off.
    expect(start({ WAL_ARCHIVE: 'off', WAL_ARCHIVE_TIMEOUT: '5' }).args).toEqual(['postgres']);
  });

  test('on archives with the project archive command, and closes a segment every 60 seconds by default', () => {
    const { args } = start({ WAL_ARCHIVE: 'on' });
    expect(args).toContain('archive_mode=on');
    expect(args).toContain('archive_timeout=60');
    expect(
      args?.some((a) => a.startsWith('archive_command=') && a.includes('purlay-wal-archive.sh')),
    ).toBe(true);
    expect(args?.[0]).toBe('postgres');
  });

  test('the timeout is the number given', () => {
    expect(start({ WAL_ARCHIVE: 'on', WAL_ARCHIVE_TIMEOUT: '5' }).args).toContain(
      'archive_timeout=5',
    );
  });

  test.each(['0', '-1', '5s', 'abc', '1.5'])(
    'an archive timeout of %p stops the database from starting, naming the variable',
    (timeout) => {
      const { outcome, args } = start({ WAL_ARCHIVE: 'on', WAL_ARCHIVE_TIMEOUT: timeout });
      expect(outcome.code).not.toBe(0);
      expect(outcome.stderr).toContain('WAL_ARCHIVE_TIMEOUT');
      expect(args).toBeNull();
    },
  );

  test.each(['yes', 'ON', 'true', '1'])(
    'a switch of %p is not on or off, so nothing starts',
    (value) => {
      const { outcome, args } = start({ WAL_ARCHIVE: value });
      expect(outcome.code).not.toBe(0);
      expect(outcome.stderr).toContain('WAL_ARCHIVE must be on or off');
      expect(args).toBeNull();
    },
  );

  test('on, with the archive not mounted, or not handed over to postgres, stops: archiving would fail on every segment', () => {
    const { outcome, args } = start({ WAL_ARCHIVE: 'on', WAL_ARCHIVE_DIR: '/does/not/exist' });
    expect(outcome.code).not.toBe(0);
    expect(args).toBeNull();
    const refused = start({ WAL_ARCHIVE: 'on', CHOWN_EXIT: '1' });
    expect(refused.outcome.code).not.toBe(0);
    expect(refused.outcome.stderr).toContain('cannot hand');
    expect(refused.args).toBeNull();
  });

  test('the compose file wires it: off by default, the wrapper as the entrypoint, the archive and both scripts mounted', () => {
    expect(compose).toContain('WAL_ARCHIVE: ${WAL_ARCHIVE:-off}');
    expect(compose).toContain('WAL_ARCHIVE_TIMEOUT: ${WAL_ARCHIVE_TIMEOUT:-60}');
    expect(compose).toContain("entrypoint: ['sh', '/usr/local/bin/purlay-postgres-start.sh']");
    expect(compose).toContain("command: ['postgres']");
    expect(compose).toContain('${WAL_ARCHIVE_PATH:-wal-archive}:/wal-archive');
    expect(compose).toContain(
      './docker/postgres-start.sh:/usr/local/bin/purlay-postgres-start.sh:ro',
    );
    expect(compose).toContain('./docker/wal-archive.sh:/usr/local/bin/purlay-wal-archive.sh:ro');
    expect(compose).toMatch(/^volumes:\n {2}postgres-data:\n {2}wal-archive:\n/m);
  });

  test('every variable of the switch is in the documents and in the env example, commented, with its default', () => {
    const example = readFileSync(join(repo, 'docker/production.env.example'), 'utf8');
    for (const name of ['WAL_ARCHIVE', 'WAL_ARCHIVE_TIMEOUT', 'WAL_ARCHIVE_PATH']) {
      expect(config).toContain(`\`${name}\``);
      expect(example).toMatch(new RegExp(`^# ${name}=`, 'm'));
    }
    expect(example).toContain('# WAL_ARCHIVE=off');
    expect(example).toContain('# WAL_ARCHIVE_TIMEOUT=60');
  });
});

// ── the scripts that talk to docker, with a stub that answers as a stack would ───────────────────

const STUB_DOCKER = String.raw`#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
[ "$1" = compose ] || exit 0
shift
file=""; envfile=""
while [ $# -gt 0 ]; do
  case "$1" in
    -f) file="$2"; shift 2 ;;
    --env-file) envfile="$2"; shift 2 ;;
    *) break ;;
  esac
done
[ -f "$file" ] || { echo "stub docker: no such compose file: $file" >&2; exit 1; }
[ -z "$envfile" ] || [ "$envfile" = /dev/null ] || [ -f "$envfile" ] || { echo "stub docker: no such env file: $envfile" >&2; exit 1; }
case "$1" in
  config) echo postgres; exit 0 ;;
  exec)
    shift 3
    if [ "$1" = timeout ]; then shift 2; fi
    case "$1" in
      pg_dump) printf 'PGDMP-stub' ;;
      pg_restore) cat >/dev/null; echo '; 1; 1259 16385 TABLE DATA public users purlay' ;;
      pg_basebackup)
        [ "$STUB_BASEBACKUP_EXIT" = 0 ] || exit "$STUB_BASEBACKUP_EXIT"
        tar -czf - -C "$STUB_BASE_LABEL_DIR" backup_label ;;
      psql)
        case "$*" in
          *archive_mode*) echo "$STUB_ARCHIVE_MODE" ;;
          *pg_stat_archiver*) echo "$STUB_ARCHIVER_FAILING" ;;
          *clock_timestamp*) echo "2026-10-27 01:00:05.123456+00" ;;
        esac ;;
      pg_archivecleanup) echo "pg_archivecleanup: keeping WAL file $*" ;;
    esac
    exit 0 ;;
esac
exit 0
`;

interface Stack {
  readonly root: string;
  readonly bin: string;
  readonly log: string;
  readonly deployment: string;
  readonly backups: string;
}

/**
 * The layout `scripts/deploy.sh` leaves: `releases/<8 hex>/` holding the scripts, the compose file and
 * `docker/`, `current` a relative link to it, and the env file in the root. No `scripts/` in the root.
 */
const stack = (): Stack => {
  const root = sandbox('stack');
  const deployment = join(root, 'deployment');
  const release = join(deployment, 'releases', 'abcd1234');
  mkdirSync(join(release, 'scripts'), { recursive: true });
  mkdirSync(join(release, 'docker'));
  for (const name of readdirSync(join(repo, 'scripts')).filter((n) => n.endsWith('.sh'))) {
    copyFileSync(join(repo, 'scripts', name), join(release, 'scripts', name));
    chmodSync(join(release, 'scripts', name), 0o755);
  }
  copyFileSync(
    join(repo, 'docker-compose.production.yml'),
    join(release, 'docker-compose.production.yml'),
  );
  cpSync(join(repo, 'docker'), join(release, 'docker'), { recursive: true });
  symlinkSync(join('releases', 'abcd1234'), join(deployment, 'current'));
  writeFileSync(join(deployment, 'production.env'), 'APP_URL=https://example.test\n', {
    mode: 0o600,
  });
  mkdirSync(join(root, 'label'));
  writeFileSync(
    join(root, 'label/backup_label'),
    'START WAL LOCATION: 0/3000028 (file 000000010000000000000003)\nCHECKPOINT LOCATION: 0/3000060\nSTART TIME: 2026-10-27 01:00:00 UTC\n',
  );
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), STUB_DOCKER, { mode: 0o755 });
  const backups = join(root, 'backups');
  mkdirSync(backups);
  return { root, bin, log: join(root, 'docker.log'), deployment, backups };
};

const stubEnv = (place: Stack, extra: Record<string, string> = {}): Record<string, string> => ({
  PATH: `${place.bin}:${BASE_PATH}`,
  HOME: place.root,
  STUB_LOG: place.log,
  STUB_ARCHIVE_MODE: 'off',
  STUB_ARCHIVER_FAILING: 'f',
  STUB_BASEBACKUP_EXIT: '0',
  STUB_BASE_LABEL_DIR: join(place.root, 'label'),
  COMPOSE_FILE: join(place.deployment, 'current/docker-compose.production.yml'),
  ENV_FILE: join(place.deployment, 'production.env'),
  ...extra,
});

const stamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
const hoursAgo = (hours: number): string => stamp(new Date(Date.now() - hours * 3_600_000));

const backupDirectory = (
  backups: string,
  name: string,
  files: readonly string[] = ['database.dump', 'SHA256SUMS'],
): string => {
  const path = join(backups, `purlay-${name}`);
  mkdirSync(path);
  for (const file of files) writeFileSync(join(path, file), 'x');
  return path;
};

// ── the monitoring hook ──────────────────────────────────────────────────────────────────────────

describe('scripts/check-backup.sh, the hook that says a night was missed', () => {
  const check = (
    place: Stack,
    args: readonly string[],
    extra: Record<string, string> = {},
  ): Outcome =>
    run(['bash', join(repo, 'scripts/check-backup.sh'), ...args], stubEnv(place, extra));

  test('a backup from a few hours ago is fine', () => {
    const place = stack();
    backupDirectory(place.backups, hoursAgo(3));
    const outcome = check(place, [place.backups]);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('backup ok');
  });

  test('the limit is 26 hours: 25 passes, 27 fails and says it is stale', () => {
    const place = stack();
    backupDirectory(place.backups, hoursAgo(25));
    expect(check(place, [place.backups]).code).toBe(0);
    const stale = stack();
    backupDirectory(stale.backups, hoursAgo(27));
    const outcome = check(stale, [stale.backups]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('BACKUP STALE');
    expect(check(stale, ['--max-age-hours', '48', stale.backups]).code).toBe(0);
  });

  test('no backup at all, or a directory that is not there, is a failure and says which', () => {
    const place = stack();
    const none = check(place, [place.backups]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('BACKUP MISSING');
    const gone = check(place, [join(place.root, 'unmounted')]);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain('BACKUP MISSING');
  });

  test('a newer directory that is not a whole backup does not hide that the last whole one is old', () => {
    const place = stack();
    backupDirectory(place.backups, hoursAgo(40));
    backupDirectory(place.backups, hoursAgo(1), ['database.dump']);
    backupDirectory(place.backups, hoursAgo(2), ['SHA256SUMS']);
    expect(check(place, [place.backups]).code).toBe(1);
  });

  test('the age is the time in the name, not the directory modification time a copy resets', () => {
    const place = stack();
    const path = backupDirectory(place.backups, hoursAgo(40));
    utimesSync(path, new Date(), new Date());
    expect(check(place, [place.backups]).code).toBe(1);
  });

  test('the time in a name is read as UTC, to the second, on both sides of a month and a leap day', () => {
    // A fixed instant: 2024-03-01T00:00:00Z is 1709251200; a name one second older than the limit fails.
    const place = stack();
    backupDirectory(place.backups, '20240229T235959Z');
    const outcome = check(place, ['--max-age-hours', '1000000', place.backups]);
    expect(outcome.code).toBe(0);
    const hours = /(\d+) hours old/.exec(outcome.stdout)?.[1];
    const expected = Math.floor((Date.now() - Date.UTC(2024, 1, 29, 23, 59, 59)) / 3_600_000);
    expect(Number(hours)).toBe(expected);
  });

  test('--wal: archiving off is reported, and is not a failure', () => {
    const place = stack();
    backupDirectory(place.backups, hoursAgo(1));
    const outcome = check(place, ['--wal', place.backups]);
    expect(outcome.code).toBe(0);
    expect(outcome.stdout).toContain('archiving is off');
  });

  test('--wal: archiving on, and a newest backup with no base backup, fails', () => {
    const place = stack();
    backupDirectory(place.backups, hoursAgo(1));
    const outcome = check(place, ['--wal', place.backups], { STUB_ARCHIVE_MODE: 'on' });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('has no base backup');
  });

  test('--wal: archiving on with a base backup passes, and a failing archiver fails', () => {
    const place = stack();
    backupDirectory(place.backups, hoursAgo(1), ['database.dump', 'SHA256SUMS', 'base.tar.gz']);
    expect(check(place, ['--wal', place.backups], { STUB_ARCHIVE_MODE: 'on' }).code).toBe(0);
    const failing = check(place, ['--wal', place.backups], {
      STUB_ARCHIVE_MODE: 'on',
      STUB_ARCHIVER_FAILING: 't',
    });
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain('WAL ARCHIVING IS FAILING');
  });
});

// ── the base backup ──────────────────────────────────────────────────────────────────────────────

describe('scripts/backup.sh and the base backup', () => {
  const backup = (place: Stack, extra: Record<string, string> = {}): Outcome =>
    run(['bash', join(repo, 'scripts/backup.sh'), place.backups], stubEnv(place, extra));
  const made = (place: Stack): string[] =>
    readdirSync(place.backups).filter((name) => name.startsWith('purlay-'));

  test('with archiving off it takes no base backup: the nightly dump of a self-hoster is what it was', () => {
    const place = stack();
    const outcome = backup(place);
    expect(outcome.code).toBe(0);
    const [directory = ''] = made(place);
    expect(readdirSync(join(place.backups, directory)).sort()).toEqual([
      'SHA256SUMS',
      'database.dump',
      'database.toc',
    ]);
    expect(readFileSync(place.log, 'utf8')).not.toContain('pg_basebackup');
  });

  test('with archiving on it adds the base backup, its label, where it began and when it was complete, all in the sums', () => {
    const place = stack();
    const outcome = backup(place, { STUB_ARCHIVE_MODE: 'on' });
    expect(outcome.code).toBe(0);
    const [directory = ''] = made(place);
    const path = join(place.backups, directory);
    expect(readdirSync(path).sort()).toEqual([
      'SHA256SUMS',
      'base.label',
      'base.meta',
      'base.tar.gz',
      'database.dump',
      'database.toc',
    ]);
    expect(readFileSync(join(path, 'base.meta'), 'utf8')).toBe(
      'start_wal=000000010000000000000003\nfinished_at=2026-10-27 01:00:05.123456+00\n',
    );
    const sums = readFileSync(join(path, 'SHA256SUMS'), 'utf8');
    for (const file of ['base.tar.gz', 'base.label', 'base.meta'])
      expect(sums).toContain(`./${file}`);
    expect(readFileSync(place.log, 'utf8')).toContain('pg_basebackup');
  });

  test('a base backup that fails fails the whole backup, and leaves nothing that looks like one', () => {
    const place = stack();
    const outcome = backup(place, { STUB_ARCHIVE_MODE: 'on', STUB_BASEBACKUP_EXIT: '1' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('base backup failed');
    expect(made(place)).toEqual([]);
  });

  test('a base backup whose label names no starting segment is refused', () => {
    const place = stack();
    writeFileSync(join(place.root, 'label/backup_label'), 'nothing useful\n');
    const outcome = backup(place, { STUB_ARCHIVE_MODE: 'on' });
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('no starting WAL segment');
    expect(made(place)).toEqual([]);
  });
});

// ── what the point-in-time restore refuses before it makes anything ──────────────────────────────

describe('scripts/restore-pitr.sh, before it creates anything', () => {
  const restore = (place: Stack, args: readonly string[]): Outcome =>
    run(['bash', join(repo, 'scripts/restore-pitr.sh'), ...args], stubEnv(place), place.root);
  /** A backup with a base backup and a SHA256SUMS that is true. */
  const whole = (place: Stack): string => {
    const path = backupDirectory(place.backups, hoursAgo(1), ['database.dump', 'base.tar.gz']);
    writeFileSync(
      join(path, 'base.meta'),
      'start_wal=000000010000000000000003\nfinished_at=2026-10-27 01:00:05.123456+00\n',
    );
    const sums = Bun.spawnSync(
      ['sh', '-c', 'shasum -a 256 database.dump base.tar.gz base.meta > SHA256SUMS'],
      { cwd: path },
    );
    expect(sums.exitCode).toBe(0);
    return path;
  };
  const dockerCalled = (place: Stack): boolean =>
    existsSync(place.log) && /docker (run|volume|rm)/.test(readFileSync(place.log, 'utf8'));

  test('it needs a time', () => {
    const place = stack();
    const outcome = restore(place, [whole(place)]);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('--to is required');
  });

  test.each([
    '2026-10-27 12:00:00',
    '2026-10-27',
    'yesterday',
    '12:00',
    "2026-10-27 12:00:00+00'; drop",
  ])('a time without a zone, or that is not a time, is refused: %p', (time) => {
    const place = stack();
    const outcome = restore(place, [whole(place), '--to', time, '--into', join(place.root, 'out')]);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('not a time with a zone');
    expect(dockerCalled(place)).toBe(false);
  });

  test('a backup taken with archiving off has no base backup, and the refusal says how to take one', () => {
    const place = stack();
    const path = backupDirectory(place.backups, hoursAgo(1), ['database.dump']);
    Bun.spawnSync(['sh', '-c', 'shasum -a 256 database.dump > SHA256SUMS'], { cwd: path });
    const outcome = restore(place, [path, '--to', '2026-10-27 12:00:00+00']);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('has no base backup');
    expect(outcome.stderr).toContain('WAL_ARCHIVE=on');
    expect(dockerCalled(place)).toBe(false);
  });

  test('a backup that does not match its sums is not used', () => {
    const place = stack();
    const path = whole(place);
    writeFileSync(join(path, 'base.tar.gz'), 'tampered');
    const outcome = restore(place, [path, '--to', 'latest', '--into', join(place.root, 'out')]);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('does not match SHA256SUMS');
    expect(dockerCalled(place)).toBe(false);
  });

  test('a directory that exists is never written into', () => {
    const place = stack();
    const into = join(place.root, 'taken');
    mkdirSync(into);
    const outcome = restore(place, [whole(place), '--to', 'latest', '--into', into]);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('already exists');
    expect(readdirSync(into)).toEqual([]);
  });

  test('a base.meta that names no segment is refused', () => {
    const place = stack();
    const path = whole(place);
    writeFileSync(join(path, 'base.meta'), 'start_wal=nope\n');
    Bun.spawnSync(['sh', '-c', 'shasum -a 256 database.dump base.tar.gz base.meta > SHA256SUMS'], {
      cwd: path,
    });
    const outcome = restore(place, [path, '--to', 'latest', '--into', join(place.root, 'out')]);
    expect(outcome.code).not.toBe(0);
    expect(outcome.stderr).toContain('does not name the WAL segment');
  });
});

// ── the retention rule ───────────────────────────────────────────────────────────────────────────

describe('scripts/prune-wal.sh, retention tied to the base backups', () => {
  const prune = (place: Stack, args: readonly string[]): Outcome =>
    run(['bash', join(repo, 'scripts/prune-wal.sh'), ...args], stubEnv(place));
  const base = (place: Stack, name: string, startWal: string, dir = place.backups): void => {
    const path = backupDirectory(dir, name, ['database.dump', 'SHA256SUMS']);
    writeFileSync(
      join(path, 'base.meta'),
      `start_wal=${startWal}\nfinished_at=2026-10-27 01:00:00+00\n`,
    );
  };
  const calls = (place: Stack): string[] =>
    existsSync(place.log) ? readFileSync(place.log, 'utf8').trim().split('\n') : [];

  test('keeps everything from the OLDEST base backup on disk and removes what precedes it', () => {
    const place = stack();
    base(place, '20261025T010000Z', '000000010000000000000009');
    base(place, '20261026T010000Z', '00000001000000000000000F');
    base(place, '20261027T010000Z', '000000010000000000000020');
    const outcome = prune(place, [place.backups]);
    expect(outcome.code).toBe(0);
    const cleanup = calls(place).filter((call) => call.includes('pg_archivecleanup'));
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]).toContain('-x .gz /wal-archive 000000010000000000000009.gz');
    expect(cleanup[0]).not.toContain(' -n ');
  });

  test('the oldest across several backup directories, such as the nightly ones and the deploy ones', () => {
    const place = stack();
    const other = join(place.root, 'deploy-backups');
    mkdirSync(other);
    base(place, '20261027T010000Z', '000000010000000000000020');
    base(place, '20261020T010000Z', '000000010000000000000004', other);
    prune(place, [place.backups, other]);
    expect(calls(place).join('\n')).toContain('000000010000000000000004.gz');
  });

  test('--dry-run asks pg_archivecleanup to only say what it would remove', () => {
    const place = stack();
    base(place, '20261027T010000Z', '000000010000000000000020');
    expect(prune(place, ['--dry-run', place.backups]).code).toBe(0);
    const cleanup = calls(place).filter((call) => call.includes('pg_archivecleanup'));
    expect(cleanup[0]).toContain(' -n ');
    expect(calls(place).some((call) => call.includes('find /wal-archive'))).toBe(false);
  });

  test('with no base backup it removes nothing: a mistyped path must not empty an archive', () => {
    const place = stack();
    backupDirectory(place.backups, '20261027T010000Z');
    const outcome = prune(place, [place.backups]);
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('nothing was pruned');
    expect(calls(place).some((call) => call.includes('pg_archivecleanup'))).toBe(false);
  });

  test('a directory that is not there, or a base.meta it cannot read, removes nothing', () => {
    const place = stack();
    expect(prune(place, [join(place.root, 'unmounted')]).code).toBe(1);
    base(place, '20261027T010000Z', 'not-a-segment');
    const outcome = prune(place, [place.backups]);
    expect(outcome.code).toBe(1);
    expect(calls(place).some((call) => call.includes('pg_archivecleanup'))).toBe(false);
  });
});

// ── the documentation, against the layout a deploy leaves ───────────────────────────────────────

/** Every cron line the document gives: five schedule fields, then a command. */
const cronLines = (): string[] =>
  config
    .split('\n')
    .filter((line) => /^[0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+ \S/.test(line));

const retarget = (line: string, place: Stack): string =>
  line
    .replaceAll('/srv/purlay-backups', place.backups)
    .replaceAll('/srv/purlay-wal', join(place.root, 'wal'))
    .replaceAll('/srv/purlay', place.deployment);

describe('the cron lines in docs/CONFIG.md, against the layout deploy.sh makes', () => {
  test('deploy.sh still makes the layout the lines assume: releases/<commit> and a relative current link', () => {
    expect(deploy).toContain('RELEASE_DIR="$DEPLOY_ROOT/releases/$SHORT"');
    expect(deploy).toContain('ln -sfn "releases/$SHORT" "$CURRENT_LINK"');
    expect(deploy).toContain('CURRENT_LINK="$DEPLOY_ROOT/current"');
  });

  test('the document gives lines for the backup, the retention, the pruning and the check', () => {
    const lines = cronLines();
    for (const script of ['backup.sh', 'prune-wal.sh', 'check-backup.sh']) {
      expect(lines.some((line) => line.includes(`current/scripts/${script}`))).toBe(true);
    }
    expect(lines.some((line) => line.includes('-mtime'))).toBe(true);
  });

  test('every script a cron line names exists, executable, where that line looks for it', () => {
    const place = stack();
    const lines = cronLines().filter((line) => /scripts\/[\w-]+\.sh/.test(line));
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      const command = retarget(line, place).replace(/^\S+ \S+ \S+ \S+ \S+ /, '');
      const directory = /\bcd (\S+)/.exec(command)?.[1] ?? place.root;
      for (const [, script] of command.matchAll(/(?:^|\s)((?:[\w./-]+\/)?scripts\/[\w-]+\.sh)/g)) {
        const path = join(directory, script ?? '');
        expect({
          line,
          path,
          there: existsSync(path) && (statSync(path).mode & 0o111) !== 0,
        }).toEqual({
          line,
          path,
          there: true,
        });
      }
    }
  });

  test('a line that names the script from the deployment root, as a flat checkout would, does not resolve', () => {
    const place = stack();
    expect(existsSync(join(place.deployment, 'scripts/backup.sh'))).toBe(false);
  });

  test('the nightly backup line, run as cron runs it (a bare environment, /bin/sh), makes a backup', () => {
    const place = stack();
    const line = cronLines().find(
      (l) => l.includes('current/scripts/backup.sh') && !l.includes('rsync'),
    );
    expect(line).toBeDefined();
    const command = retarget(line ?? '', place).replace(/^\S+ \S+ \S+ \S+ \S+ /, '');
    const outcome = run(
      ['/bin/sh', '-c', command],
      {
        PATH: `${place.bin}:${BASE_PATH}`,
        HOME: place.root,
        STUB_LOG: place.log,
        STUB_ARCHIVE_MODE: 'off',
      },
      '/',
    );
    expect(outcome.stderr).toBe('');
    expect(outcome.code).toBe(0);
    const made = readdirSync(place.backups).filter((name) => name.startsWith('purlay-'));
    expect(made).toHaveLength(1);
    expect(existsSync(join(place.backups, made[0] ?? '', 'SHA256SUMS'))).toBe(true);
    expect(readFileSync(join(place.backups, 'backup.log'), 'utf8')).toContain('checksums:');
    // And the compose file it named is the one in the release, not a guess.
    expect(readFileSync(place.log, 'utf8')).toContain(
      `-f ${place.deployment}/current/docker-compose.production.yml --env-file ${place.deployment}/production.env`,
    );
  });

  test('the check line, run as cron runs it, passes after that backup and fails when there is none', () => {
    const place = stack();
    const line = cronLines().find((l) => l.includes('current/scripts/check-backup.sh'));
    expect(line).toBeDefined();
    const command = retarget(line ?? '', place).replace(/^\S+ \S+ \S+ \S+ \S+ /, '');
    const env = { PATH: `${place.bin}:${BASE_PATH}`, HOME: place.root, STUB_LOG: place.log };
    expect(run(['/bin/sh', '-c', command], env, '/').code).not.toBe(0);
    backupDirectory(place.backups, hoursAgo(2));
    expect(run(['/bin/sh', '-c', command], env, '/').code).toBe(0);
  });
});

// ── the numbers the document states are the ones the system has ──────────────────────────────────

describe('the stated RPO and the stated monitoring limit are the ones in the code', () => {
  const stated = (pattern: RegExp): number => Number(pattern.exec(config)?.[1] ?? Number.NaN);

  test('the RPO with archiving on is the default archive_timeout', () => {
    const fromCompose = Number(/WAL_ARCHIVE_TIMEOUT:-(\d+)/.exec(compose)?.[1]);
    expect(stated(/\*\*RPO with archiving on: (\d+) seconds/)).toBe(fromCompose);
    expect(fromCompose).toBe(60);
  });

  test('the RPO without it is one backup interval: 24 hours, as nightly', () => {
    expect(stated(/\*\*RPO without it: (\d+) hours/)).toBe(24);
  });

  test('the age check fails at the limit the document states', () => {
    const fromScript = Number(
      /^MAX_HOURS=(\d+)$/m.exec(readFileSync(join(repo, 'scripts/check-backup.sh'), 'utf8'))?.[1],
    );
    expect(stated(/older than (\d+) hours/)).toBe(fromScript);
  });
});
