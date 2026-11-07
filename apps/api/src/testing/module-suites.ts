/**
 * The integration suites that do not belong to one module, run once per cell of the matrix (D-250 rule 6, `MODULES.md` §8).
 *
 *   bun run modules:suites            every cell
 *   bun run modules:suites -- none    only the cells whose `MODULES` is given (`none`, `chat`, `chat,issues`), to work on one
 *
 * For each cell (`moduleCells`: the core alone, each module with what it requires, everything but the last), a database of
 * its own is migrated with only the sets that cell's `MODULES` names and every integration suite that does not need a module the
 * cell lacks is run on it with `MODULES` set, so the application a test builds is the one that setting starts
 * (`testDependencies`). A suite that needs a module (`module-needs.ts`) is left out of the cells without it, said with its
 * reason; one that needs none must pass in all of them — that is what "the core's behaviour does not depend on which modules run"
 * means, checked by running it rather than by reading it.
 *
 * The cell that runs every module is not run here: it is what `bun run test:all` is, the whole suite on the whole schema.
 * Unit tests are not run per cell either: they read no `MODULES`, so a second run would repeat the first.
 *
 * It lives in `testing/` for the reasons `module-smoke.ts` does: it is run as a process and imports the test matrix.
 */
import { randomBytes } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  createDatabase,
  databaseNameFromUrl,
  dropDatabases,
  integrationTemplateName,
  onDatabase,
  scratchDatabaseName,
  sql,
} from '@purlay/db';
import { bundledModules } from '../composition';
import { moduleCells, type ModuleCell } from './module-cells';
import { needsReader, type NeedsOf } from './module-needs';

/** Whether something accepts connections at the address of a URL: Redis's, to say plainly that its suites were left out. */
const reachable = async (url: string): Promise<boolean> => {
  const { hostname, port } = new URL(url);
  try {
    const socket = await Bun.connect({
      hostname,
      port: Number(port),
      socket: { data: () => undefined },
    });
    socket.end();
    return true;
  } catch {
    return false;
  }
};

const REPOSITORY = resolve(import.meta.dir, '../../../..');

/** Where integration suites are: the API and the database package. The scripts' own suites test the repository's tooling. */
export const SUITE_ROOTS: readonly string[] = [
  join('apps', 'api', 'src'),
  join('packages', 'db', 'src'),
];

const INTEGRATION = '.integration.test.ts';
const REDIS_SUITE = '.redis.integration.test.ts';

/** Two files at a time, as `test:all` runs them (`scripts/test-all.ts`): each has its own transaction or clone. */
const WORKERS = 2;

/** Every integration suite of the repository, as an absolute path. */
export const integrationSuites = (root: string = REPOSITORY): readonly string[] =>
  SUITE_ROOTS.flatMap((directory) =>
    readdirSync(join(root, directory), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith(INTEGRATION) && !file.includes('node_modules'))
      .map((file) => join(root, directory, file)),
  ).sort();

export interface Left {
  readonly file: string;
  /** The modules the suite needs that the cell does not run. */
  readonly missing: readonly string[];
}

/** What a cell runs of the suites, and what it leaves out with the modules each one lacks. */
export const partition = (
  suites: readonly string[],
  needsOf: NeedsOf,
  running: readonly string[],
): { readonly runs: readonly string[]; readonly left: readonly Left[] } => {
  const runs: string[] = [];
  const left: Left[] = [];
  for (const file of suites) {
    const missing = needsOf(file).filter((id) => !running.includes(id));
    if (missing.length === 0) runs.push(file);
    else left.push({ file, missing });
  }
  return { runs, left };
};

/** The cells this command runs: all but the one that runs every module the build carries, which `test:all` is. */
export const cellsToRun = (
  carried: readonly string[],
  cells: readonly ModuleCell[],
): readonly ModuleCell[] => cells.filter((cell) => cell.ids.length < carried.length);

/** What was left out, grouped by what it needs: "27 suites need chat", the way a reader checks it is a rule and not a list. */
export const leftOutLines = (left: readonly Left[]): readonly string[] => {
  const counts = new Map<string, number>();
  for (const { missing } of left) {
    const needs = missing.join(' + ');
    counts.set(needs, (counts.get(needs) ?? 0) + 1);
  }
  return [...counts].map(
    ([needs, count]) => `${String(count)} suites need ${needs}, which this cell does not run`,
  );
};

/** The `MODULES` value as a database name's part: `none`, or the ids joined. */
const slug = (cell: ModuleCell): string => (cell.setting ?? 'all').replaceAll(/[^a-z0-9]+/g, '_');

export interface CellVerdict {
  readonly cell: ModuleCell;
  readonly suites: number;
  readonly exitCode: number;
}

/** Where the command says what it found: its output is its interface. */
export interface Say {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const stdio: Say = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/**
 * One cell: its database made and dropped around a `bun test` of the suites it runs, started the way `test:all` starts it
 * except for `MODULES` and the database. The suites' own clones and templates are `${database}_…`, dropped by the files that made
 * them and by `dropDatabases` here for the template.
 */
const runCell = async (
  cell: ModuleCell,
  suites: readonly string[],
  base: string,
  database: string,
): Promise<number> => {
  const admin = createDatabase({ connectionString: onDatabase(base, 'postgres'), poolSize: 1 });
  try {
    await sql`create database ${sql.id(database)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  // A `MODULES` this shell exports is not the cell's: the cell says its own, or none of it.
  const inherited = { ...process.env };
  delete inherited['MODULES'];
  try {
    return await Bun.spawn(
      [
        'bun',
        '--no-env-file',
        'test',
        '--isolate',
        `--parallel=${String(WORKERS)}`,
        ...suites.map((file) => `./${relative(REPOSITORY, file)}`),
      ],
      {
        cwd: REPOSITORY,
        env: {
          ...inherited,
          DATABASE_URL: onDatabase(base, database),
          ...(cell.setting === undefined ? {} : { MODULES: cell.setting }),
        },
        stdout: 'inherit',
        stderr: 'inherit',
      },
    ).exited;
  } finally {
    await dropDatabases([integrationTemplateName(database), database]);
  }
};

export const main = async (
  environment: Readonly<Record<string, string | undefined>>,
  say: Say = stdio,
  run: typeof runCell = runCell,
  only: readonly string[] = [],
): Promise<number> => {
  const base = environment['DATABASE_URL'] ?? '';
  if (base === '') {
    say.err('modules:suites — DATABASE_URL is not set, so no cell was run.');
    return 1;
  }
  const redisUrl = environment['REDIS_URL'] ?? '';
  const redisHere = redisUrl !== '' && (await reachable(redisUrl));
  if (!redisHere) {
    say.out(
      'modules:suites — no Redis answers: the shared adapters’ suites (*.redis.integration.test.ts) are left out',
    );
  }
  const needsOf = needsReader(bundledModules.map((module) => module.manifest.id));
  const carried = bundledModules.map((module) => module.manifest.id);
  const suites = integrationSuites().filter((file) => redisHere || !file.endsWith(REDIS_SUITE));
  const prefix = `${databaseNameFromUrl(base)}_cells_${randomBytes(4).toString('hex')}`;
  const verdicts: CellVerdict[] = [];
  const chosen = cellsToRun(carried, moduleCells(bundledModules)).filter(
    (cell) => only.length === 0 || only.includes(cell.setting ?? ''),
  );
  if (chosen.length === 0) {
    say.err(`modules:suites — no cell has MODULES ${only.join(', ')}, so nothing was run.`);
    return 1;
  }
  for (const cell of chosen) {
    const { runs, left } = partition(suites, needsOf, cell.ids);
    say.out(
      `\nmodules:suites — ${cell.label} (MODULES=${cell.setting ?? '(unset)'}): ${String(runs.length)} suites`,
    );
    for (const line of leftOutLines(left)) say.out(`  left out: ${line}`);
    verdicts.push({
      cell,
      suites: runs.length,
      exitCode: await run(cell, runs, base, scratchDatabaseName(`${prefix}_${slug(cell)}`)),
    });
  }
  say.out('');
  for (const { cell, suites: count, exitCode } of verdicts) {
    const verdict = exitCode === 0 ? 'ok  ' : 'FAIL';
    const said = exitCode === 0 ? say.out : say.err;
    said(
      `${verdict} ${cell.label}: MODULES=${cell.setting ?? '(unset)'}, ${String(count)} suites, exit ${String(exitCode)}`,
    );
  }
  return verdicts.every((verdict) => verdict.exitCode === 0) ? 0 : 1;
};

if (import.meta.main) process.exit(await main(process.env, stdio, runCell, Bun.argv.slice(2)));
