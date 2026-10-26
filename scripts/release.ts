/**
 * `bun run release -- <patch|minor|major|x.y.z> [--dry-run]`: opens the pull request that releases a
 * version (D-185). What it does, and its tests, are `scripts/release-prepare.ts`; this only starts it.
 */
import { join } from 'node:path';
import { cli, spawnIn } from './release-prepare';

const root = join(import.meta.dir, '..');
process.exit(
  cli(process.argv.slice(2), {
    root,
    exec: spawnIn(root),
    today: new Date().toISOString().slice(0, 10),
    out: console.log,
    err: console.error,
  }),
);
