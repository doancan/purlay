/**
 * What the job command may not do, read from its source because the command is a script that runs when it is imported: it
 * hands a module's job the database its runner names (the module's share of the pool) and writes no record of a run itself
 * (D-274). `modules/jobs/module-shares.integration.test.ts` holds what the runner does with them.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dir, 'jobs.ts'), 'utf8');
const occurrences = (needle: string): number => source.split(needle).length - 1;

describe('the job command', () => {
  test('gives a module’s job the database its runner hands it, and no other', () => {
    expect(occurrences('contextOn(')).toBe(1);
    expect(occurrences('work(contextOn(on, job))')).toBe(1);
  });

  test('runs every job through the runner, which records the run, and does not record one itself', () => {
    expect(occurrences('scheduledJobRunner(')).toBe(1);
    expect(source).not.toMatch(/\brunJob\(/);
  });
});
