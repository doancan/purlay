/** `bun run mutate [id ...]`: applies the mutations in `scripts/mutations.ts` (see `scripts/mutate.ts`). */
import { join } from 'node:path';
import { acceptable, report, runMutations } from './mutate';
import { MUTATIONS } from './mutations';

const wanted = process.argv.slice(2);
const chosen = wanted.length === 0 ? MUTATIONS : MUTATIONS.filter((m) => wanted.includes(m.id));
if (chosen.length === 0) {
  console.error(`no mutation matches ${wanted.join(', ')}`);
  process.exit(2);
}
const verdicts = runMutations({ root: join(import.meta.dir, '..'), mutations: chosen });
console.log(report(verdicts));
process.exit(acceptable(verdicts) ? 0 : 1);
