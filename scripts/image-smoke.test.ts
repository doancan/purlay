/**
 * The image smoke test brings its own database (#231).
 *
 * It used to run the API container against the development compose PostgreSQL through
 * `host.docker.internal`. When the development ports were bound to the loopback address
 * (they should be: the superuser's password is in the repository), a container on the CI
 * runner could no longer reach the database, `migrating on start failed` was the whole of the
 * log, and the `image` check was red on main for three commits without anyone being stopped —
 * because it was not yet a required check. A smoke test that depends on what some other file
 * publishes will break the next time that file is made safer.
 *
 * So it creates a throwaway network and a throwaway PostgreSQL of its own, reached by container
 * name, with nothing published, and removes both when it ends. These tests keep it that way.
 */
import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
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
const script = readFileSync(join(repo, 'scripts/image-smoke.sh'), 'utf8');
const code = script
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');
const workflow = readFileSync(join(repo, '.github/workflows/image.yml'), 'utf8');

describe('scripts/image-smoke.sh', () => {
  test('does not reach the database through the host or the development compose file', () => {
    for (const forbidden of [
      'host.docker.internal',
      'host-gateway',
      'localhost:5432',
      'localhost:${POSTGRES_PORT',
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // It does not read a DATABASE_URL either: there is no database of the host's to point at.
    expect(code).not.toMatch(/DATABASE_URL="\$\{DATABASE_URL/);
  });

  test('creates a private network and a database of its own on it, publishes nothing for the database, and removes both', () => {
    expect(code).toMatch(/docker network create/);
    expect(code).toMatch(/docker run[^\n]*--network/);
    expect(code).toMatch(/docker network rm/);
    // Only the API's port is published (to the loopback address, for the host's curl).
    const publishes = [...code.matchAll(/\s-p\s+"?([^\s"]+)/g)].map((match) => match[1] ?? '');
    expect(publishes).toEqual(['127.0.0.1:$HOST_PORT:3001']);
    expect(code).toMatch(/trap\s+\S+\s+EXIT/);
  });

  test('takes the PostgreSQL image from docker-compose.yml, so it is named in one place', () => {
    const compose = readFileSync(join(repo, 'docker-compose.yml'), 'utf8');
    expect(/image:\s*postgres:\S+/.test(compose)).toBe(true);
    expect(code).toContain('docker-compose.yml');
  });
});

describe('the image workflow', () => {
  test('does not start the development database for the smoke test', () => {
    const steps = workflow.split('\n').filter((line) => !line.trim().startsWith('#'));
    expect(steps.join('\n')).not.toMatch(/docker compose up[^\n]*postgres/);
  });
});

/**
 * Waiting for the database, run against a `docker` that answers the way the real image does.
 *
 * The official PostgreSQL image starts a TEMPORARY server while it runs its init scripts. It listens
 * on the unix socket only, answers `pg_isready`, and is shut down a moment later; the server that
 * stays opens TCP. A wait that asks over the socket stops on the temporary one and the very next
 * question finds nothing: "the throwaway database never became ready", on a deploy and on a first try,
 * and never on the second. The stub answers on a clock of calls: the first is the temporary server
 * (socket only), the next two are the gap, and from the fourth on the real one answers both.
 */
describe('scripts/image-smoke.sh waits for the database that stays', () => {
  const run = (
    env: Record<string, string> = {},
  ): { code: number; stderr: string; started: boolean } => {
    const dir = mkdtempSync(join(tmpdir(), 'smoke-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const put = (name: string, body: string): void => {
        writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
      };
      put('sleep', 'exit 0');
      put(
        'docker',
        String.raw`case "$1 $2" in
  "exec "*)
    n=$(( $(cat "$DIR/calls" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$DIR/calls"
    case " $* " in *" -h 127.0.0.1 "*) tcp=1 ;; *) tcp=0 ;; esac
    if [ -n "$NEVER_READY" ]; then exit 1; fi
    if [ "$n" -eq 1 ] && [ "$tcp" -eq 0 ]; then exit 0; fi   # the temporary server: socket only
    if [ "$n" -ge 4 ]; then exit 0; fi                        # the server that stays
    exit 1 ;;
  "run -d")
    case " $* " in *POSTGRES_USER=purlay*) exit 0 ;; esac
    touch "$DIR/api-started"; exit 1 ;;                       # stop where the wait is over
esac
exit 0`,
      );
      const result = Bun.spawnSync(
        ['bash', join(repo, 'scripts/image-smoke.sh'), 'purlay-api:test'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, HOME: dir, DIR: dir, ...env },
        },
      );
      return {
        code: result.exitCode,
        stderr: result.stderr.toString(),
        started: existsSync(join(dir, 'api-started')),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test('is not taken in by the temporary server that the image starts first', () => {
    const outcome = run();
    expect(outcome.stderr).not.toContain('never became ready');
    expect(outcome.started).toBe(true);
  });

  test('gives up, and says so, on a database that never comes', () => {
    const outcome = run({ NEVER_READY: '1' });
    expect(outcome.code).toBe(1);
    expect(outcome.stderr).toContain('the throwaway database never became ready');
    expect(outcome.started).toBe(false);
  });
});
