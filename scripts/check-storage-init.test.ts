import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const project = 'purlay-demo';
const image = 'ghcr.io/purlay/purlay-api@sha256:' + 'a'.repeat(64);
const imageId = 'sha256:' + 'b'.repeat(64);
const container = 'c'.repeat(64);
const timestamp = '2026-11-26T12:00:00.003Z';
const never = '0001-01-01T00:00:00Z';
const entrypoint = '["/usr/local/bin/bun"]';
const completed = [
  project,
  'storage-init',
  'False',
  imageId,
  '["apps/api/src/cli/storage-init.ts"]',
  'exited',
  '0',
  timestamp,
  timestamp,
  entrypoint,
];

const run = (
  options: {
    readonly args?: readonly string[];
    readonly docker?: Record<string, string>;
    readonly state?: readonly string[];
  } = {},
): { code: number; out: string; err: string } => {
  const directory = mkdtempSync(join(tmpdir(), 'storage-init-check-'));
  try {
    writeFileSync(
      join(directory, 'docker'),
      `#!/bin/bash
set -eu
case "$1 $2" in
  "image inspect")
    [ "$3" = --format ] && [ "$4" = '{{.Id}}|{{json .Config.Entrypoint}}' ] && [ "$5" = "$TEST_IMAGE" ] || exit 9
    [ "$TEST_IMAGE_KNOWN" = yes ] || exit 8
    printf '%s\\n' "$TEST_IMAGE_DETAILS"
    ;;
  "container ls")
    shift 2
    [ "$1 $2" = '--all --no-trunc' ] &&
      [ "$3 $4" = "--filter label=com.docker.compose.project=$TEST_PROJECT" ] &&
      [ "$5 $6" = '--filter label=com.docker.compose.service=storage-init' ] &&
      [ "$7 $8" = '--format {{.ID}}|{{.Label "com.docker.compose.oneoff"}}' ] || exit 9
    printf '%s\\n' "$TEST_CONTAINER_LIST"
    ;;
  "container inspect")
    [ "$3" = --format ] && [ "$5" = "$TEST_CONTAINER_ID" ] || exit 9
    [ "$TEST_CONTAINER_PRESENT" = yes ] || exit 8
    printf '%s\\n' "$TEST_STATE"
    ;;
  *) exit 9 ;;
esac
`,
      { mode: 0o700 },
    );
    const result = Bun.spawnSync(
      [
        'bash',
        join(import.meta.dir, 'check-storage-init.sh'),
        ...(options.args ?? [project, image]),
      ],
      {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env['PATH'] ?? ''}`,
          TEST_PROJECT: project,
          TEST_IMAGE: image,
          TEST_IMAGE_DETAILS: [imageId, entrypoint].join('|'),
          TEST_IMAGE_KNOWN: 'yes',
          TEST_CONTAINER_ID: container,
          TEST_CONTAINER_LIST: container + '|False',
          TEST_CONTAINER_PRESENT: 'yes',
          TEST_STATE: (options.state ?? completed).join('|'),
          ...options.docker,
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 1_000,
      },
    );
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('verifying a completed Dockhand storage initializer', () => {
  test('accepts the one Compose service whose expected command exited zero at the tested digest', () => {
    expect(run()).toEqual({
      code: 0,
      out: `storage-init: ${project} completed for ${image} at ${timestamp}\n`,
      err: '',
    });
  });

  test.each([
    [5, 'created', 'has not finished'],
    [5, 'running', 'has not finished'],
    [6, '1', 'initializer failed (exit code: 1)'],
    [7, never, 'no start or finish time'],
    [8, never, 'no start or finish time'],
    [3, 'sha256:' + 'd'.repeat(64), 'did not use the tested image'],
    [4, '["apps/api/src/index.ts"]', 'unexpected initializer command'],
    [9, '["/bin/false"]', 'unexpected initializer command'],
    [0, 'other-project', "not the stack's managed initializer"],
    [1, 'scheduler', "not the stack's managed initializer"],
    [2, 'True', "not the stack's managed initializer"],
  ] satisfies [number, string, string][])(
    'refuses mismatched inspect field %i (%s)',
    (index, value, reason) => {
      const state = [...completed];
      state[index] = value;
      const result = run({ state });
      expect(result.code).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).toContain(reason);
    },
  );

  test('refuses missing or additional candidates instead of trusting a container name', () => {
    for (const list of ['', `${container}|False\n${'d'.repeat(64)}|False`]) {
      const result = run({ docker: { TEST_CONTAINER_LIST: list } });
      expect(result.code).toBe(1);
      expect(result.err).toContain('exactly one managed storage-init container');
    }
  });

  test('handles optional one-off labels and leaves compose run containers out', () => {
    const state = [...completed];
    state[2] = '';
    expect(
      run({ state, docker: { TEST_CONTAINER_LIST: `${'d'.repeat(64)}|True\n${container}|` } }).code,
    ).toBe(0);
  });

  test('requires an immutable local digest and a valid project', () => {
    expect(run({ args: [project, 'ghcr.io/purlay/purlay-api:release'] }).err).toContain(
      'by digest',
    );
    expect(run({ args: ['--unexpected', image] }).err).toContain('Compose project name');
    expect(run({ docker: { TEST_IMAGE_KNOWN: 'no' } }).err).toContain('unavailable locally');
    expect(run({ docker: { TEST_CONTAINER_PRESENT: 'no' } }).err).toContain('disappeared');
  });
});
