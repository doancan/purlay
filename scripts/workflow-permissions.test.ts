/**
 * A workflow gets only the token it needs (#247).
 *
 * Without a `permissions:` block a workflow inherits the repository default,
 * which may be read-write on everything. Each workflow here states a top-level
 * block that grants nothing beyond reading contents, and a job that needs more
 * says so on the job, where a reviewer sees which job holds the power.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS = join(import.meta.dir, '../.github/workflows');

/** The top-level `permissions:` block: its scopes, or undefined when there is none. */
const topLevelPermissions = (text: string): Record<string, string> | undefined => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^permissions:\s*$/.test(line));
  if (start === -1) return undefined;
  const scopes: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    const scope = /^ {2}([\w-]+):\s*(\w+)\s*(?:#.*)?$/.exec(line);
    if (scope === null) break;
    const [, name = '', level = ''] = scope;
    scopes[name] = level;
  }
  return scopes;
};

const workflows = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

describe('workflow permissions', () => {
  test('the reader sees a missing block, a write grant and a read-only block', () => {
    expect(topLevelPermissions('name: x\non: push\n')).toBeUndefined();
    expect(topLevelPermissions('permissions:\n  contents: write\n\njobs:\n')).toEqual({
      contents: 'write',
    });
    expect(topLevelPermissions('permissions:\n  contents: read # why\n\njobs:\n')).toEqual({
      contents: 'read',
    });
  });

  test('there are workflows to judge', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  for (const name of workflows) {
    test(`${name} declares a top-level block that grants nothing beyond read`, () => {
      const scopes = topLevelPermissions(readFileSync(join(WORKFLOWS, name), 'utf8'));
      expect(scopes).toBeDefined();
      expect(Object.values(scopes ?? {}).filter((level) => level !== 'read')).toEqual([]);
    });
  }
});
