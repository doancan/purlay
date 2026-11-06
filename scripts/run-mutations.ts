/**
 * `bun run mutate [id ...] [--changed=<ref>] [--shard=<index>/<count>]`: applies the mutations in
 * `scripts/mutations/` (see `scripts/mutate.ts`).
 *
 * - ids: only those entries.
 * - `--changed=<ref>`: the entries this tree adds or changes since the merge-base with `<ref>`; none is a pass.
 *   What every pull request that touches the list runs (`ci.yml`'s `mutations-changed`).
 * - `--shard=2/6`: the second of six divisions of the list by area file (the weekly run, `mutations.yml`).
 */
import { join } from 'node:path';
import { acceptable, report, runMutations } from './mutate';
import { MUTATIONS, MUTATIONS_BY_AREA } from './mutations';
import { changedIds, mergeBase, mutationsAt, parseShard, shardOf } from './mutation-selection';

const flag = (name: string): string | undefined =>
  process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const wanted = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const changedSince = flag('changed');
const shard = flag('shard');

const select = async (): Promise<readonly (typeof MUTATIONS)[number][]> => {
  if (changedSince !== undefined) {
    const ids = changedIds(await mutationsAt(mergeBase(changedSince)), MUTATIONS);
    console.log(
      `added or changed since ${changedSince}: ${ids.length === 0 ? 'none' : ids.join(', ')}`,
    );
    return MUTATIONS.filter((m) => ids.includes(m.id));
  }
  if (shard !== undefined) {
    const { index, count } = parseShard(shard);
    return shardOf(MUTATIONS_BY_AREA, index, count);
  }
  return wanted.length === 0 ? MUTATIONS : MUTATIONS.filter((m) => wanted.includes(m.id));
};

const chosen = await select();
if (chosen.length === 0 && changedSince !== undefined) process.exit(0);
if (chosen.length === 0) {
  console.error(`no mutation matches ${wanted.join(', ')}`);
  process.exit(2);
}
const verdicts = runMutations({ root: join(import.meta.dir, '..'), mutations: chosen });
console.log(report(verdicts));
process.exit(acceptable(verdicts) ? 0 : 1);
