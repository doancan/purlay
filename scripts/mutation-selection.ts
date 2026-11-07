/**
 * Which mutations a run applies when it is not "all of them, here" (`CONTRIBUTING.md` §5): the ones a
 * pull request added or changed, which every pull request that touches the list proves, and one shard of
 * the whole list, which the weekly run divides over parallel jobs. Both are pure over the entries, so
 * `mutation-selection.test.ts` can state them without a repository.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mutation } from './mutate';

/**
 * The ids of the entries of `head` that `base` does not have, or has with any field different: a changed
 * `find`, `replace` or `tests` is a different mutation, and one nobody has seen caught. An entry only
 * `base` has was removed, and there is nothing to run for it.
 */
export const changedIds = (base: readonly Mutation[], head: readonly Mutation[]): string[] => {
  const before = new Map(base.map((entry) => [entry.id, JSON.stringify(entry)]));
  return head.filter((entry) => before.get(entry.id) !== JSON.stringify(entry)).map((e) => e.id);
};

/** The mutations of the area files `index` to `count` of the list, each area whole, balanced by entries. */
export const shardOf = (
  byArea: Readonly<Record<string, readonly Mutation[]>>,
  index: number,
  count: number,
): Mutation[] => {
  const shards = Array.from({ length: count }, () => ({ weight: 0, areas: [] as string[] }));
  const largestFirst = Object.entries(byArea).sort(
    ([nameA, a], [nameB, b]) => b.length - a.length || (nameA < nameB ? -1 : 1),
  );
  for (const [name, entries] of largestFirst) {
    const lightest = shards.reduce((least, shard) => (shard.weight < least.weight ? shard : least));
    lightest.weight += entries.length;
    lightest.areas.push(name);
  }
  return shards[index - 1]!.areas.sort().flatMap((name) => byArea[name]!);
};

/** `2/6` as `{ index: 2, count: 6 }`; anything else, or an index outside the count, is refused. */
export const parseShard = (text: string): { index: number; count: number } => {
  const match = /^(\d+)\/(\d+)$/.exec(text);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || index < 1 || index > count) {
    throw new Error(`--shard wants \`index/count\` with 1 <= index <= count, not \`${text}\``);
  }
  return { index, count };
};

const git = (args: readonly string[]): string => {
  const done = Bun.spawnSync(['git', ...args], { stderr: 'pipe' });
  if (done.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${done.stderr.toString()}`);
  return done.stdout.toString().trim();
};

/** The list as it stands at `ref`, read from a checkout of only `scripts/mutations/` in a directory of its own. */
export const mutationsAt = async (ref: string): Promise<readonly Mutation[]> => {
  const directory = mkdtempSync(join(tmpdir(), 'purlay-mutations-at-'));
  try {
    const archive = Bun.spawnSync(
      ['git', 'archive', ref, 'scripts/mutate.ts', 'scripts/mutations'],
      {
        stderr: 'pipe',
      },
    );
    if (archive.exitCode !== 0) {
      throw new Error(`cannot read the list at ${ref}: ${archive.stderr.toString()}`);
    }
    const unpack = Bun.spawnSync(['tar', '-x', '-C', directory], {
      stdin: archive.stdout,
      stderr: 'pipe',
    });
    if (unpack.exitCode !== 0) {
      throw new Error(`cannot unpack the list at ${ref}: ${unpack.stderr.toString()}`);
    }
    const module = (await import(join(directory, 'scripts/mutations/index.ts'))) as {
      MUTATIONS: readonly Mutation[];
    };
    return module.MUTATIONS;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** The merge-base of `HEAD` and `base`: what the pull request is measured against, not the base's moving tip. */
export const mergeBase = (base: string): string => git(['merge-base', 'HEAD', base]);
