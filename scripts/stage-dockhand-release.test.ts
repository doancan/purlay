import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const project = 'purlay-demo';
const digest = 'a'.repeat(64);
const image = `ghcr.io/purlay/purlay-api@sha256:${digest}`;
const revision = 'e'.repeat(40);
const directory = join(import.meta.dir, '..');

const docker = `#!/bin/bash
set -eu
api=$(printf '%064d' 1)
scheduler=$(printf '%064d' 2)
new_api=$(printf '%064d' 6)
new_scheduler=$(printf '%064d' 7)
postgres=$(printf '%064d' 3)
garage=$(printf '%064d' 4)
storage=$(printf '%064d' 5)
image_id="sha256:$TEST_DIGEST"
stamp='2026-11-26T12:00:00.003Z'
entrypoint='["/usr/local/bin/bun"]'
state="$TEST_DIRECTORY/state"
trace="$TEST_DIRECTORY/trace"
case "$1 $2" in
  "image inspect")
    [ "$5" = "$TEST_IMAGE" ] || exit 9
    detail="$TEST_REVISION"
    case "$4" in
      *Entrypoint*) detail="$entrypoint" ;;
      *revision*) [ "$TEST_MODE" != bad-revision ] || detail=wrong ;;
      *) exit 9 ;;
    esac
    printf '%s|%s\\n' "$image_id" "$detail"
    ;;
  "container ls")
    if [ "$#" -eq 7 ]; then
      [ "$TEST_MODE" != occupied ] || printf '%s\\n' "$garage"
      exit 0
    fi
    case "$8" in
      *=api) id="$api"; [ ! -f "$state/api" ] || id="$new_api" ;;
      *=scheduler) id="$scheduler"; [ ! -f "$state/scheduler" ] || id="$new_scheduler" ;;
      *=postgres) id="$postgres" ;;
      *=garage) id="$garage" ;;
      *=storage-init) id="$storage" ;;
      *) exit 9 ;;
    esac
    if [[ "$TEST_MODE" = *fresh || "$TEST_MODE" = occupied ]]; then
      [ -f "$state/api" ] || exit 0
    fi
    printf '%s|False\\n' "$id"
    ;;
  "volume ls")
    if [[ "$TEST_MODE" = orphan-volumes || ( "$TEST_MODE" = unlabeled-volume && "$3" = --format ) ]]; then
      printf '%s\\n' "${project}_postgres-data"
    fi
    ;;
  "container inspect")
    case "$5" in
      "$api"|"$new_api") service=api ;;
      "$scheduler"|"$new_scheduler") service=scheduler ;;
      "$postgres") service=postgres ;;
      "$garage") service=garage ;;
      "$storage") service=managed-init ;;
      "$TEST_PROJECT"-storage-preflight-*) service=one-off ;;
      *) exit 9 ;;
    esac
    case "$service" in
      managed-init|one-off)
        label=False
        code=0
        if [ "$service" = one-off ]; then
          [ -f "$state/$5" ] || exit 9
          label=True
          [ "$TEST_MODE" != bad-receipt ] || code=1
        elif [[ "$TEST_MODE" = interrupted* && "$TEST_MODE" != interrupted-fresh ]]; then
          image_id='sha256:old'
        fi
        printf '%s|storage-init|%s|%s|["apps/api/src/cli/storage-init.ts"]|exited|%s|%s|%s|%s\\n' \
          "$TEST_PROJECT" "$label" "$image_id" "$code" "$stamp" "$stamp" "$entrypoint"
        ;;
      *)
        selected='ghcr.io/purlay/purlay-api:old'
        actual='sha256:old'
        if [ -f "$state/$service" ]; then selected="$TEST_IMAGE"; actual="$image_id"; fi
        if [[ "$service" = garage && "$TEST_MODE" = interrupted-changed-store && -f "$TEST_DIRECTORY/interrupted" ]]; then
          stamp='2026-11-26T12:05:00.003Z'
        fi
        printf '%s|%s|%s|running|healthy|%s\\n' "$5" "$actual" "$selected" "$stamp"
        ;;
    esac
    ;;
  "compose --project-name")
    [ "$3" = "$TEST_PROJECT" ] && [ "$5" = "$TEST_DIRECTORY/stack.env" ] &&
      [ "$PURLAY_IMAGE" = "$TEST_IMAGE" ] && [ "$COMPOSE_REMOVE_ORPHANS" = false ] || exit 9
    shift 7
    case "$*" in
      'config --quiet') ;;
      'exec -T backup pg_restore --list')
        printf 'validate dump\\n' >> "$trace"
        [ "$(cat)" = 'fixture dump' ] || exit 9
        [ "$TEST_MODE" != bad-backup ] || exit 8
        printf '1234; 1259 200 TABLE public kysely_migration purlay\\n'
        ;;
      'run --no-deps --pull never -T --name '*' storage-init')
        printf 'run initializer\\n' >> "$trace"
        [ "$TEST_MODE" != refused ] || exit 1
        touch "$state/$7"
        [ "$TEST_MODE" != changed-backup ] || printf 'changed' >> "$TEST_DIRECTORY/pre-update.dump"
        ;;
      'stop scheduler') printf 'stop scheduler\\n' >> "$trace" ;;
      'up -d --no-deps --pull never --wait --wait-timeout 900 api')
        printf 'start API\\n' >> "$trace"
        [ "$TEST_MODE" != api-refused ] || exit 1
        touch "$state/api"
        ;;
      'up -d --no-deps --pull never --wait --wait-timeout 900 scheduler')
        printf 'start scheduler\\n' >> "$trace"
        touch "$state/scheduler"
        ;;
      'up -d --wait --wait-timeout 900 api scheduler backup')
        printf 'start empty project\\n' >> "$trace"
        touch "$state/api" "$state/scheduler"
        ;;
      *) exit 9 ;;
    esac
    ;;
  *) exit 9 ;;
esac
`;

function withFixture(
  mode: string,
  check: (
    run: (fresh?: boolean) => {
      code: number;
      out: string;
      err: string;
      trace: string;
      receipts: string[];
      record: string;
    },
  ) => void,
): void {
  const fixture = mkdtempSync(join(tmpdir(), 'stage-dockhand-'));
  try {
    writeFileSync(join(fixture, 'docker'), docker, { mode: 0o700 });
    writeFileSync(
      join(fixture, 'mv'),
      `#!/bin/bash
set -eu
if [[ "$TEST_MODE" = interrupted* && "$3" = *.receipt && ! -f "$TEST_DIRECTORY/interrupted" ]]; then
  touch "$TEST_DIRECTORY/interrupted"
  exit 1
fi
exec /bin/mv "$@"
`,
      { mode: 0o700 },
    );
    writeFileSync(join(fixture, 'stack.env'), '');
    writeFileSync(join(fixture, 'pre-update.dump'), 'fixture dump');
    writeFileSync(join(fixture, 'trace'), '');
    mkdirSync(join(fixture, 'state'));
    check((fresh) => {
      const result = Bun.spawnSync(
        [
          join(directory, 'scripts/stage-dockhand-release.sh'),
          project,
          join(fixture, 'stack.env'),
          image,
          revision,
          fresh ? '--fresh' : join(fixture, 'pre-update.dump'),
        ],
        {
          env: {
            ...process.env,
            PATH: `${fixture}:${process.env['PATH'] ?? ''}`,
            COMPOSE_REMOVE_ORPHANS: 'true',
            PURLAY_DOCKHAND_RECEIPTS: fixture,
            TEST_DIRECTORY: fixture,
            TEST_DIGEST: digest,
            TEST_PROJECT: project,
            TEST_REVISION: revision,
            TEST_IMAGE: image,
            TEST_MODE: mode,
          },
          timeout: 5_000,
        },
      );
      const receipts = readdirSync(fixture).filter((entry) => entry.endsWith('.receipt'));
      const receipt = receipts[0];
      return {
        code: result.exitCode,
        out: result.stdout.toString(),
        err: result.stderr.toString(),
        trace: readFileSync(join(fixture, 'trace'), 'utf8'),
        receipts,
        record: receipt ? readFileSync(join(fixture, receipt), 'utf8') : '',
      };
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe('staging the existing Dockhand stack', () => {
  test('verifies one-off preparation and orders reader replacement, then verifies an unchanged release', () => {
    withFixture('normal', (run) => {
      const first = run();
      expect(first.err).toBe('');
      expect(first.code).toBe(0);
      expect(first.trace).toBe(
        'validate dump\nrun initializer\nstop scheduler\nstart API\nstart scheduler\n',
      );
      expect(first.receipts).toEqual([`${project}-${digest}.receipt`]);
      expect(first.record).toContain(`revision=${revision}`);
      expect(first.record).toContain('storage-init: purlay-demo completed');
      expect(first.record).toMatch(/backup_sha256=[0-9a-f]{64}\n/);
      const second = run();
      expect(second.code).toBe(0);
      expect(second.out).toContain('already ready');
      expect(second.trace).toBe(first.trace);
      expect(second.record).toBe(first.record);
    });
  });

  test.each([
    ['bad-revision', 'does not match the tested revision', ''],
    ['bad-backup', 'could not read the protected dump', 'validate dump\n'],
    ['refused', 'initializer refused', 'validate dump\nrun initializer\n'],
    ['bad-receipt', 'without a verified receipt', 'validate dump\nrun initializer\n'],
    ['changed-backup', 'protected dump changed', 'validate dump\nrun initializer\n'],
    [
      'api-refused',
      'scheduler release was withheld',
      'validate dump\nrun initializer\nstop scheduler\nstart API\n',
    ],
  ])('withholds dependent operations on %s', (mode, reason, trace) => {
    withFixture(mode, (run) => {
      const result = run();
      expect(result.code).toBe(1);
      expect(result.err).toContain(reason);
      expect(result.trace).toBe(trace);
      expect(result.receipts).toEqual([]);
    });
  });

  test('uses normal Compose dependencies only for an explicitly empty project', () => {
    withFixture('fresh', (run) => {
      const result = run(true);
      expect(result.err).toBe('');
      expect(result.code).toBe(0);
      expect(result.trace).toBe('start empty project\n');
      expect(result.record).toContain('backup_sha256=\n');
      const second = run(true);
      expect(second.code).toBe(0);
      expect(second.trace).toBe(result.trace);
    });
    for (const mode of ['occupied', 'orphan-volumes', 'unlabeled-volume']) {
      withFixture(mode, (run) => {
        const result = run(true);
        expect(result.code).toBe(1);
        expect(result.err).toContain('without containers or volumes');
        expect(result.trace).toBe('');
      });
    }
  });

  test('recovers the receipt after an interrupted completed rollout without running another deployment', () => {
    withFixture('interrupted', (run) => {
      const first = run();
      expect(first.code).toBe(1);
      expect(first.receipts).toEqual([]);
      expect(first.trace.endsWith('start scheduler\n')).toBe(true);
      const recovered = run();
      expect(recovered.code).toBe(0);
      expect(recovered.trace).toBe(first.trace);
      expect(recovered.record).toMatch(/backup_sha256=[0-9a-f]{64}\n/);
      expect(run().out).toContain('already ready');
    });
  });

  test('refuses to recover an interrupted receipt after Garage has restarted', () => {
    withFixture('interrupted-changed-store', (run) => {
      const first = run();
      expect(first.code).toBe(1);
      const retry = run();
      expect(retry.code).toBe(1);
      expect(retry.err).toContain('could not be associated with its verified preflight');
      expect(retry.trace).toBe(first.trace);
      expect(retry.receipts).toEqual([]);
    });
  });

  test('recovers incomplete bookkeeping after an empty project starts successfully', () => {
    withFixture('interrupted-fresh', (run) => {
      const first = run(true);
      expect(first.code).toBe(1);
      expect(first.receipts).toEqual([]);
      const second = run(true);
      expect(second.code).toBe(0);
      expect(second.trace).toBe('start empty project\n');
      expect(second.receipts).toHaveLength(1);
    });
  });
});
