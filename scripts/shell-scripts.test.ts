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

  test('the checker for the parse test does fail on a broken script', () => {
    const run = Bun.spawnSync(['bash', '-n', '-c', 'if then fi'], { stderr: 'pipe' });
    expect(run.exitCode).not.toBe(0);
  });
});
