/** The real CLI selects changed entries into disjoint shards; only its execution engine is held. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mutation } from './mutate';

const directory = mkdtempSync(join(tmpdir(), 'purlay-changed-cli-'));
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});
mkdirSync(join(directory, 'scripts/mutations'), { recursive: true });
for (const name of ['run-mutations.ts', 'mutation-selection.ts'])
  writeFileSync(join(directory, 'scripts', name), readFileSync(join(import.meta.dir, name)));
writeFileSync(
  join(directory, 'scripts/mutate.ts'),
  `
import { writeFileSync } from 'node:fs';
export interface Mutation { readonly id: string; }
export const runMutations = ({ mutations }: { readonly mutations: readonly Mutation[] }) => {
  writeFileSync('executed.json', JSON.stringify(mutations.map((entry) => entry.id)));
  return mutations.map((entry) => ({ id: entry.id, outcome: 'caught' }));
};
export const acceptable = (verdicts: readonly { outcome: string }[]) => verdicts.every((entry) => entry.outcome === 'caught');
export const report = () => 'execution captured';
`,
);
const git = (...args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: directory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const entry = (id: string, find = 'before'): Mutation => ({
  id,
  why: 'a bounded guard',
  file: 'scripts/a.ts',
  find,
  replace: 'after',
  tests: ['scripts/a.test.ts'],
});
const keep = (entries: readonly Mutation[]): void => {
  writeFileSync(
    join(directory, 'scripts/mutations/index.ts'),
    `export const MUTATIONS = ${JSON.stringify(entries)};\nexport const MUTATIONS_BY_AREA = { one: MUTATIONS };\n`,
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Mutation fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'test: record mutation fixture',
  );
};
git('init', '--quiet');
keep([entry('unchanged'), entry('modified'), entry('removed')]);
const base = git('rev-parse', 'HEAD');
const added = Array.from({ length: 10 }, (_, index) => entry(`added-${String(index)}`));
keep([entry('unchanged'), entry('modified', 'new guard'), ...added]);
const head = git('rev-parse', 'HEAD');
const chosen = (flags: readonly string[]): { readonly exit: number; readonly ids: string[] } => {
  const file = join(directory, 'executed.json');
  rmSync(file, { force: true });
  const result = Bun.spawnSync(
    [process.execPath, '--no-env-file', 'scripts/run-mutations.ts', ...flags],
    {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  return {
    exit: result.exitCode,
    ids: existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as string[]) : [],
  };
};

describe('the changed-mutation CLI with shards', () => {
  test('runs every changed entry exactly once across four shards and never runs an unchanged or removed entry', () => {
    const expected = ['modified', ...added.map((entry) => entry.id)].sort();
    const shards = Array.from({ length: 4 }, (_, index) =>
      chosen([`--changed=${base}`, `--shard=${String(index + 1)}/4`]),
    );
    for (const shard of shards) expect(shard.exit).toBe(0);
    expect(shards.flatMap((shard) => shard.ids).sort()).toEqual(expected);
    expect(
      Math.max(...shards.map((shard) => shard.ids.length)) -
        Math.min(...shards.map((shard) => shard.ids.length)),
    ).toBeLessThanOrEqual(1);
  });
  test('an empty changed set executes nothing, while a malformed combined shard is refused', () => {
    expect(chosen([`--changed=${head}`, '--shard=1/4'])).toEqual({ exit: 0, ids: [] });
    expect(chosen([`--changed=${base}`, '--shard=0/4']).exit).not.toBe(0);
  });
});
