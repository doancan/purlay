/** The real CI command must catch every changed entry, including one declared equivalent. */
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mutation } from './mutate';

const roots: string[] = [];

const git = (root: string, ...args: string[]): void => {
  const result = Bun.spawnSync(['git', '-C', root, ...args], {
    env: {
      PATH: process.env['PATH'] ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
};

const commit = (root: string): void => {
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--no-gpg-sign',
    '-m',
    'fixture',
  );
};

const catalogue = (root: string, entries: readonly Mutation[]): void => {
  writeFileSync(
    join(root, 'scripts/mutations/index.ts'),
    `import type { Mutation } from '../mutate';\nexport const MUTATIONS: readonly Mutation[] = ${JSON.stringify(entries)};\nexport const MUTATIONS_BY_AREA = { fixture: MUTATIONS };\n`,
  );
};

/** A complete tiny repository, using the actual command, selector and runner. */
const aRepository = (equivalent: boolean): string => {
  const root = mkdtempSync(join(tmpdir(), 'purlay-mutation-command-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts/mutations'), { recursive: true });
  for (const file of ['run-mutations.ts', 'mutation-selection.ts', 'mutate.ts']) {
    copyFileSync(join(import.meta.dir, file), join(root, 'scripts', file));
  }
  writeFileSync(join(root, 'target.ts'), 'export const value = 1;\n');
  writeFileSync(
    join(root, 'target.test.ts'),
    `import { expect, test } from 'bun:test';\nimport { value } from './target';\ntest('the value', () => { expect(value).${equivalent ? 'toBeGreaterThan(0)' : 'toBe(1)'}; });\n`,
  );
  catalogue(root, []);
  git(root, 'init', '-b', 'fixture');
  commit(root);
  catalogue(root, [
    {
      id: 'fixture-value-changed',
      why: 'the value changed',
      file: 'target.ts',
      find: '= 1;',
      replace: '= 2;',
      tests: ['target.test.ts'],
      ...(equivalent ? { equivalent: 'Both values are positive.' } : {}),
    },
  ]);
  commit(root);
  return root;
};

const command = (root: string, flag: string): { code: number; output: string } => {
  const result = Bun.spawnSync(
    [process.execPath, '--no-env-file', 'scripts/run-mutations.ts', flag],
    {
      cwd: root,
      env: { PATH: process.env['PATH'] ?? '' },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
    },
  );
  return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('the mutation command used by CI', () => {
  test('refuses a changed entry that survives even when it declares equivalence', () => {
    const result = command(aRepository(true), '--changed=HEAD^');
    expect(result.output).toContain('1 mutations: 0 caught, 0 survived, 0 stale, 1 equivalent');
    expect(result.code).toBe(1);
  });

  test('retains declared equivalents in a weekly shard of the existing list', () => {
    const result = command(aRepository(true), '--shard=1/1');
    expect(result.output).toContain('1 equivalent');
    expect(result.code).toBe(0);
  });

  test('passes a changed entry whose named test catches the mutation', () => {
    const result = command(aRepository(false), '--changed=HEAD^');
    expect(result.output).toContain('1 mutations: 1 caught, 0 survived, 0 stale, 0 equivalent');
    expect(result.code).toBe(0);
  });

  test('passes a change with no changed entries without running mutations', () => {
    const result = command(aRepository(true), '--changed=HEAD');
    expect(result.output).toContain('none');
    expect(result.output).not.toContain('mutations:');
    expect(result.code).toBe(0);
  });
});
