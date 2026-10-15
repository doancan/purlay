/**
 * The operational scripts are scripts that can run (#248).
 *
 * Their behaviour is exercised by `restore-rehearsal.sh` in a workflow of its own,
 * which needs Docker. What a unit test can hold cheaply is the part that fails
 * silently at the worst moment: a syntax error on a path the rehearsal does not
 * reach, a missing `set -euo pipefail` (a failed `pg_dump` in a pipeline would
 * otherwise leave an empty backup and a zero exit), or a file that lost its
 * executable bit.
 */
import { describe, expect, test } from 'bun:test';
import { closeSync, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = import.meta.dir;
const scripts = readdirSync(directory).filter((name) => name.endsWith('.sh'));

/** Sourced libraries are not run, so they neither need the executable bit nor `set -e` of their own. */
const LIBRARIES = new Set(['ops-common.sh']);

describe('the shell scripts', () => {
  test('there are some to judge', () => {
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts).toContain('backup.sh');
    expect(scripts).toContain('restore.sh');
  });

  test.each(scripts)('%s parses', (name) => {
    const run = Bun.spawnSync(['bash', '-n', join(directory, name)], { stderr: 'pipe' });
    expect(run.stderr.toString()).toBe('');
    expect(run.exitCode).toBe(0);
  });

  test.each(scripts.filter((name) => !LIBRARIES.has(name)))(
    '%s is executable and stops at the first failure',
    (name) => {
      const path = join(directory, name);
      // One open file for the mode and the text: a `stat` and then a `read` of a path is
      // a check of one file and a use of another if it changes between them (CodeQL
      // js/file-system-race).
      const descriptor = openSync(path, 'r');
      let mode: number;
      let text: string;
      try {
        mode = fstatSync(descriptor).mode;
        text = readFileSync(descriptor, 'utf8');
      } finally {
        closeSync(descriptor);
      }
      expect(mode & 0o111).not.toBe(0);
      expect(text.startsWith('#!/usr/bin/env bash\n')).toBe(true);
      expect(text).toMatch(/^set -euo pipefail$/m);
    },
  );

  // Under `pipefail`, `… | grep -q` is a race: grep leaves at its first match, the writer dies of
  // SIGPIPE if it has more to say, and the pipeline fails though the line was there. `has_api`
  // answered "no API" on two runs in five that way, and a backup skipped the bucket with exit 0.
  // `grep … >/dev/null` reads to the end, so the answer is the match's.
  test.each(scripts)('%s never pipes into grep -q', (name) => {
    const text = readFileSync(join(directory, name), 'utf8');
    expect(text.split('\n').filter((line) => /\|\s*grep\s+-\w*q/.test(line))).toEqual([]);
  });

  test('a pipe into grep -q does fail under pipefail, which is why it is refused', () => {
    const run = Bun.spawnSync([
      'bash',
      '-c',
      'set -o pipefail; for i in $(seq 20); do yes | head -c 200000 | grep -q y || exit 1; done',
    ]);
    expect(run.exitCode).not.toBe(0);
  });

  test('the checker for the parse test does fail on a broken script', () => {
    const run = Bun.spawnSync(['bash', '-n', '-c', 'if then fi'], { stderr: 'pipe' });
    expect(run.exitCode).not.toBe(0);
  });
});
