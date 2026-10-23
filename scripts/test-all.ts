/**
 * Every test, unit and integration together, with coverage held to its floor.
 *
 * `verify` used to run the unit tests only, so a green local `verify` covered two
 * thirds of the lines and almost none of the services — every one of which is
 * exercised by an integration test (#202). This runs both whenever a database is
 * reachable, which is the gate CI runs.
 *
 * **Without a database it says so, loudly, and runs the unit tests alone** — the
 * fast loop must not depend on Docker. **In CI it refuses instead**: there the
 * database is part of the job, and its absence is a broken pipeline, not a
 * reason to report success on half the suite (`CONTRIBUTING.md` §6.4).
 *
 * The coverage floor lives in `bunfig.toml`, where `bun test --coverage` reads it.
 */
import { reachable } from './database-reachable';

const ROOTS = ['apps', 'packages', 'scripts'];

const run = (args: readonly string[]): number =>
  Bun.spawnSync(['bun', '--no-env-file', '--env-file=.env.test', 'test', ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
  }).exitCode;

const url = process.env['DATABASE_URL'] ?? '';
const inCi = process.env['CI'] === 'true';

if (url !== '' && (await reachable(url))) {
  console.log(`test:all — unit and integration, with coverage (${new URL(url).host})`);
  process.exit(run([...ROOTS, '--coverage']));
}

const reason = url === '' ? 'DATABASE_URL is not set' : `nothing answers at ${new URL(url).host}`;
if (inCi) {
  console.error(
    `test:all — ${reason}, and CI provides the database. Refusing to report half a suite.`,
  );
  process.exit(1);
}

console.log(
  [
    '',
    '════════════════════════════════════════════════════════════════════════',
    `  INTEGRATION TESTS NOT RUN — ${reason}.`,
    '  This is the unit suite only: not the gate CI runs, and not a pass.',
    '  Start a database and run again:  bun run db:up:postgres',
    '════════════════════════════════════════════════════════════════════════',
    '',
  ].join('\n'),
);
process.exit(run([...ROOTS, '--path-ignore-patterns', '**/*.integration.test.ts']));
