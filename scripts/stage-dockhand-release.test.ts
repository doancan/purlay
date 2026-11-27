import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const project = 'purlay-demo';
const digest = 'a'.repeat(64);
const registry = 'ghcr.io/purlay/purlay-api';
const image = `${registry}@sha256:${digest}`;
const revision = 'e'.repeat(40);
const oldDigest = 'b'.repeat(64);
const oldRevision = 'd'.repeat(40);
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
if [ "$TEST_VERIFY" = true ]; then
  case "$1 $2" in
    "image inspect"|"container ls"|"container inspect") ;;
    *) printf 'unexpected Docker operation during verification: %s %s\\n' "$1" "$2" >&2; exit 9 ;;
  esac
fi
case "$1 $2" in
  "buildx imagetools")
    [ "$3 $4" = 'inspect --format' ] && [ "$5" = '{{.Manifest.Digest}}' ] || exit 9
    case "$6" in
      "$TEST_REGISTRY":release)
        [ "$TEST_MODE" != scheduled-lag ] || image_id="sha256:$TEST_OLD_DIGEST"
        ;;
      "$TEST_REGISTRY:sha-$TEST_REVISION") ;;
      *) exit 9 ;;
    esac
    printf '%s\\n' "$image_id"
    ;;
  "image inspect")
    [ ! -f "$state/image-missing" ] || exit 9
    detail="$TEST_REVISION"
    if [ "$5" = "$TEST_REGISTRY@sha256:$TEST_OLD_DIGEST" ]; then
      detail="$TEST_OLD_REVISION"
      image_id="sha256:$TEST_OLD_DIGEST"
    else
      [ "$5" = "$TEST_IMAGE" ] || exit 9
    fi
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
          [ ! -f "$state/initializer-replaced" ] || stamp='2026-11-26T12:05:00.003Z'
          if [[ "$TEST_VERIFY" = true && "$TEST_MODE" = verify-race-* ]]; then
            touch "$state/initializer-read"
          fi
        elif [[ "$TEST_MODE" = interrupted* && "$TEST_MODE" != interrupted-fresh ]]; then
          image_id='sha256:old'
        fi
        printf '%s|storage-init|%s|%s|["apps/api/src/cli/storage-init.ts"]|exited|%s|%s|%s|%s\\n' \
          "$TEST_PROJECT" "$label" "$image_id" "$code" "$stamp" "$stamp" "$entrypoint"
        ;;
      *)
        if [[ "$TEST_VERIFY" = true && "$service" = scheduler && -f "$state/initializer-read" ]]; then
          case "$TEST_MODE" in
            verify-race-lock) mkdir "$TEST_DIRECTORY/$TEST_PROJECT.lock" ;;
            verify-race-receipt) printf 'another operator changed the receipt\\n' >> "$TEST_DIRECTORY/$TEST_PROJECT-$TEST_DIGEST.receipt" ;;
          esac
        fi
        selected='ghcr.io/doancan/purlay-api:release'
        actual='sha256:old'
        if [[ "$TEST_MODE" = scheduled-* ]]; then
          selected="$TEST_REGISTRY@sha256:$TEST_OLD_DIGEST"
          actual="sha256:$TEST_OLD_DIGEST"
        fi
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
      'exec -T backup pg_dump --format=custom --no-owner --no-acl')
        printf 'take dump\\n' >> "$trace"
        printf '%s' 'fixture dump'
        ;;
      'exec -T backup pg_restore --file=/dev/null')
        printf 'read dump payload\\n' >> "$trace"
        [ "$(cat)" = 'fixture dump' ] || exit 9
        if [[ "$TEST_MODE" = scheduled-unreadable && ! -f "$state/temporary-read-error" ]]; then
          touch "$state/temporary-read-error"
          exit 1
        fi
        ;;
      'exec -T backup pg_restore --list')
        printf 'validate dump\\n' >> "$trace"
        [ "$(cat)" = 'fixture dump' ] || exit 9
        [ "$TEST_MODE" != bad-backup ] || exit 8
        [ "$TEST_MODE" != scheduled-network ] || touch "$state/archive-listed"
        printf '1234; 1259 200 TABLE public kysely_migration purlay\\n'
        ;;
      'run --no-deps --pull never -T --name '*' storage-init')
        printf 'run initializer\\n' >> "$trace"
        if [[ "$TEST_MODE" = scheduled-* ]]; then
          attempt="$TEST_DIRECTORY/$TEST_PROJECT-$TEST_DIGEST.attempted"
          grep -Fqx -- "initializer=$7" "$attempt" || exit 9
        fi
        [[ "$TEST_MODE" != refused && "$TEST_MODE" != scheduled-refused ]] || exit 1
        touch "$state/$7"
        [ "$TEST_MODE" != changed-backup ] || printf 'changed' >> "$TEST_DIRECTORY/pre-update.dump"
        [ "$TEST_MODE" != scheduled-changed ] || touch "$state/new-publication"
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
    run: (fresh?: boolean | 'verify') => {
      code: number;
      out: string;
      err: string;
      trace: string;
      receipts: string[];
      record: string;
      backups: string[][];
      attempts: string[];
    },
    fixture: string,
  ) => void,
): void {
  const fixture = mkdtempSync(join(tmpdir(), 'stage-dockhand-'));
  try {
    writeFileSync(join(fixture, 'docker'), docker, { mode: 0o700 });
    writeFileSync(
      join(fixture, 'git'),
      `#!/bin/bash
set -eu
case "$3" in
  fetch) ;;
  rev-parse) printf '%s\\n' "$TEST_REVISION" ;;
  merge-base)
    if [ "$5" = "$TEST_OLD_REVISION" ]; then
      [ "$TEST_MODE" != scheduled-rollback ]
    else
      [ "$TEST_MODE" != scheduled-off-main ]
    fi
    ;;
  *) exit 9 ;;
esac
`,
      { mode: 0o700 },
    );
    writeFileSync(
      join(fixture, 'curl'),
      `#!/bin/bash
set -eu
[ "\${*: -1}" = https://api.github.com/repos/purlay/purlay/releases/latest ] || exit 9
if [[ "$TEST_MODE" = scheduled-network && -f "$TEST_DIRECTORY/state/archive-listed" &&
  ! -f "$TEST_DIRECTORY/state/temporary-network-error" ]]; then
  touch "$TEST_DIRECTORY/state/temporary-network-error"
  exit 1
fi
if [ -f "$TEST_DIRECTORY/state/new-publication" ]; then
  printf '{"tag_name":"v2.1.0"}\\n'
else
  printf '{"tag_name":"v2.0.0"}\\n'
fi
`,
      { mode: 0o700 },
    );
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
    mkdirSync(join(fixture, 'backups'));
    if (mode === 'scheduled-pending') writeFileSync(join(fixture, `${project}.preflight`), '');
    check((fresh) => {
      const verify = fresh === 'verify';
      const args = verify
        ? ['--verify', image, revision]
        : [
            join(fixture, 'stack.env'),
            ...(mode.startsWith('scheduled-')
              ? ['--follow-release', registry, join(fixture, 'backups')]
              : [image, revision, fresh ? '--fresh' : join(fixture, 'pre-update.dump')]),
          ];
      const result = Bun.spawnSync(
        [join(directory, 'scripts/stage-dockhand-release.sh'), project, ...args],
        {
          env: {
            ...process.env,
            PATH: `${fixture}:${process.env['PATH'] ?? ''}`,
            COMPOSE_REMOVE_ORPHANS: 'true',
            PURLAY_DOCKHAND_RECEIPTS: fixture,
            TEST_DIRECTORY: fixture,
            TEST_DIGEST: digest,
            TEST_OLD_DIGEST: oldDigest,
            TEST_OLD_REVISION: oldRevision,
            TEST_PROJECT: project,
            TEST_REGISTRY: registry,
            TEST_REVISION: revision,
            TEST_IMAGE: image,
            TEST_MODE: mode,
            TEST_VERIFY: String(verify),
          },
          timeout: 5_000,
        },
      );
      const entries = readdirSync(fixture);
      const receipts = entries.filter((entry) => entry.endsWith('.receipt'));
      const receipt = receipts[0];
      return {
        code: result.exitCode,
        out: result.stdout.toString(),
        err: result.stderr.toString(),
        trace: readFileSync(join(fixture, 'trace'), 'utf8'),
        receipts,
        record: receipt ? readFileSync(join(fixture, receipt), 'utf8') : '',
        backups: readdirSync(join(fixture, 'backups')).map((entry) =>
          readdirSync(join(fixture, 'backups', entry)),
        ),
        attempts: entries.filter((entry) => entry.endsWith('.attempted')),
      };
    }, fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe('staging the existing Dockhand stack', () => {
  test('verifies the recorded release without staging when readers or local evidence differ', () => {
    withFixture('normal', (run, fixture) => {
      const before = run('verify');
      expect(before.code).toBe(1);
      expect(before.err).toContain('both readers must be healthy at the tested digest');
      expect(before.trace).toBe('');

      const staged = run();
      expect(staged.code).toBe(0);
      const verified = run('verify');
      expect(verified.code).toBe(0);
      expect(verified.out).toContain('verified at');
      expect(verified.trace).toBe(staged.trace);
      expect(verified.record).toBe(staged.record);

      const receipt = join(fixture, `${project}-${digest}.receipt`);
      const wrongImage = staged.record.replace(`image=${image}`, `image=${registry}:release`);
      writeFileSync(receipt, wrongImage);
      const mismatched = run('verify');
      expect(mismatched.code).toBe(1);
      expect(mismatched.err).toContain('do not match a completed release receipt');
      expect(mismatched.record).toBe(wrongImage);
      expect(mismatched.trace).toBe(staged.trace);

      writeFileSync(receipt, staged.record);
      writeFileSync(join(fixture, 'state', 'initializer-replaced'), '');
      const replaced = run('verify');
      expect(replaced.code).toBe(1);
      expect(replaced.err).toContain('initializer completion differs');
      expect(replaced.record).toBe(staged.record);
      expect(replaced.trace).toBe(staged.trace);

      writeFileSync(join(fixture, 'state', 'image-missing'), '');
      const missingImage = run('verify');
      expect(missingImage.code).toBe(1);
      expect(missingImage.err).toContain('tested image is unavailable locally');
      expect(missingImage.trace).toBe(staged.trace);
    });
  });

  test.each(['verify-race-lock', 'verify-race-receipt'])(
    'refuses a concurrent %s change during the final reader inspection',
    (mode) => {
      withFixture(mode, (run, fixture) => {
        const staged = run();
        expect(staged.code).toBe(0);
        const verified = run('verify');
        expect(verified.code).toBe(1);
        expect(verified.err).toContain('readers, receipt or project lock changed');
        expect(verified.trace).toBe(staged.trace);
        if (mode === 'verify-race-lock') {
          expect(readdirSync(fixture)).toContain(`${project}.lock`);
          expect(verified.record).toBe(staged.record);
        } else {
          expect(verified.record).toBe(`${staged.record}another operator changed the receipt\n`);
        }
      });
    },
  );

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
      const verified = run('verify');
      expect(verified.code).toBe(0);
      expect(verified.trace).toBe(result.trace);
      expect(verified.record).toBe(result.record);
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
      const inspected = run('verify');
      expect(inspected.code).toBe(1);
      expect(inspected.err).toContain('do not match a completed release receipt');
      expect(inspected.receipts).toEqual([]);
      expect(inspected.trace).toBe(first.trace);
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

describe('following the tested release channel', () => {
  test('keeps a single protected dump for a healthy forward release and skips unchanged work', () => {
    withFixture('scheduled-normal', (run) => {
      const first = run();
      expect(first.code).toBe(0);
      expect(first.trace).toBe(
        'take dump\nread dump payload\nvalidate dump\nrun initializer\nstop scheduler\nstart API\nstart scheduler\n',
      );
      expect(first.record).toMatch(/backup_sha256=[0-9a-f]{64}\n/);
      const next = run();
      expect(next.code).toBe(0);
      expect(next.out).toContain('already ready');
      expect(next.trace).toBe(first.trace);
    });
  });

  test.each([
    ['scheduled-lag', 'does not yet match the tested main build', ''],
    ['scheduled-off-main', 'outside main', ''],
    ['scheduled-rollback', 'not a forward revision', ''],
    ['scheduled-pending', 'earlier rollout has a pending preflight', ''],
    [
      'scheduled-refused',
      'initializer refused',
      'take dump\nread dump payload\nvalidate dump\nrun initializer\n',
    ],
    [
      'scheduled-changed',
      'release changed during preflight',
      'take dump\nread dump payload\nvalidate dump\nrun initializer\n',
    ],
  ])('withholds promotion on %s', (mode, reason, trace) => {
    withFixture(mode, (run) => {
      const result = run();
      expect(result.code).toBe(1);
      expect(result.err).toContain(reason);
      expect(result.trace).toBe(trace);
      expect(result.receipts).toEqual([]);
      if (trace) {
        expect(result.backups).toEqual([['postgres.dump']]);
        expect(result.attempts).toHaveLength(1);
        const next = run();
        expect(next.err).toContain('already has an automatic attempt');
        expect(next.trace).toBe(trace);
      }
    });
  });

  test.each([
    ['scheduled-unreadable', 'dump payload could not be read', 'take dump\nread dump payload\n'],
    [
      'scheduled-network',
      'could not be reverified',
      'take dump\nread dump payload\nvalidate dump\n',
    ],
  ])('retries the same digest after a temporary preparation error on %s', (mode, reason, trace) => {
    withFixture(mode, (run) => {
      const first = run();
      expect(first.code).toBe(1);
      expect(first.err).toContain(reason);
      expect(first.trace).toBe(trace);
      expect(first.backups).toEqual([]);
      expect(first.attempts).toEqual([]);
      const next = run();
      expect(next.code).toBe(0);
      expect(next.trace).toBe(
        `${trace}take dump\nread dump payload\nvalidate dump\nrun initializer\nstop scheduler\nstart API\nstart scheduler\n`,
      );
      expect(next.backups).toEqual([['postgres.dump']]);
      expect(next.attempts).toHaveLength(1);
      expect(next.receipts).toHaveLength(1);
    });
  });
});
