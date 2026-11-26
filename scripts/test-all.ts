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
 *
 * **One area of it, when `PURLAY_TEST_AREA=web|scripts|api` is set** (D-340): CI runs the suite as three areas
 * side by side, each on a runner of its own, and this runs the test files of one (`scripts/test-area.ts` says which
 * are whose) in one process. That process loads files of other areas too, which their own area's tests answer for,
 * so it runs under a copy of `bunfig.toml` with the floor at zero, writes its coverage as lcov to
 * `coverage/area-<name>/` with a `summary.json` saying how many files it ran, and `scripts/coverage-floor.ts`
 * holds each file to the real floor in the process of the area that owns it. `web` needs no database and
 * starts none; the other two refuse to run without one, in CI or out of it, rather than run the unit tests under
 * an area's name. Without the variable nothing here differs from before.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { reachable } from './database-reachable';
import {
  type Area,
  areaDirectory,
  areaOfTest,
  needsServices,
  parseArea,
  testFilesOnDisk,
  withoutFloor,
} from './test-area';

const cohortMode = process.env['PURLAY_WORKSPACE_COHORT'];
if (cohortMode !== undefined && cohortMode !== 'functional' && cohortMode !== 'measure') {
  console.error('PURLAY_WORKSPACE_COHORT must be functional or measure, or unset for strict');
  process.exit(1);
}

const ROOTS = ['apps', 'packages', 'scripts'];

/**
 * Two files at a time (D-228): each still has globals of its own (`--isolate`), every integration test its
 * own transaction or clone, and the coverage floor is judged on the merged report. Not one a core: four
 * files cloning the integration template at once wait on each other past the five seconds a hook is given.
 */
const WORKERS = 2;

const testCommand = (args: readonly string[]): string[] => [
  'bun',
  '--no-env-file',
  '--env-file=.env.test',
  'test',
  '--isolate',
  `--parallel=${String(WORKERS)}`,
  ...args,
];

const run = (args: readonly string[]): number =>
  Bun.spawnSync(testCommand(args), {
    env: { ...process.env, PURLAY_WORKSPACE_COHORT: 'functional' },
    stdout: 'inherit',
    stderr: 'inherit',
  }).exitCode;

/** What `bun test` ends its report with: `Ran 30222 tests across 1081 files. [1425.64s]`, or `Ran 1 test across 1 file.` */
const RAN = /Ran (\d+) tests? across (\d+) files?/;

/**
 * One area of the suite: its test files, in one process, with the output going on as it comes. The line that says
 * how many files ran is kept, because the check that follows compares it with the files the area owns: an area that
 * ends without that line did not run what it says, whatever its exit code.
 */
const runArea = async (area: Area, leftOut: readonly string[]): Promise<number> => {
  const directory = areaDirectory(area);
  mkdirSync(directory, { recursive: true });
  const config = `${directory}/bunfig.toml`;
  writeFileSync(config, withoutFloor(readFileSync('bunfig.toml', 'utf8')));
  const files = testFilesOnDisk().filter((file) => areaOfTest(file) === area);
  const child = Bun.spawn(
    testCommand([
      ...files,
      `--config=${config}`,
      '--coverage-reporter=lcov',
      `--coverage-dir=${directory}`,
      ...leftOut,
    ]),
    {
      env: { ...process.env, PURLAY_WORKSPACE_COHORT: 'functional' },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const pump = async (
    stream: ReadableStream<Uint8Array>,
    sink: { write: (text: string) => unknown },
  ): Promise<string> => {
    const decoder = new TextDecoder();
    let tail = '';
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      sink.write(text);
      tail = (tail + text).slice(-4096);
    }
    return tail;
  };
  const [out, err] = await Promise.all([
    pump(child.stdout, process.stdout),
    pump(child.stderr, process.stderr),
  ]);
  const code = await child.exited;
  const ran = RAN.exec(`${out}\n${err}`);
  if (ran === null) {
    console.error(
      `test:all — the ${area} area ended without saying how many files it ran. Refusing to count it.`,
    );
    return code === 0 ? 1 : code;
  }
  writeFileSync(
    `${directory}/summary.json`,
    `${JSON.stringify({ area, tests: Number(ran[1]), files: Number(ran[2]), expected: files.length, exitCode: code })}\n`,
  );
  return code;
};

let area;
try {
  area = parseArea(process.env['PURLAY_TEST_AREA']);
} catch (error) {
  console.error(`test:all — ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

const url = process.env['DATABASE_URL'] ?? '';
const inCi = process.env['CI'] === 'true';
const redisUrl = process.env['REDIS_URL'] ?? '';

if (area !== undefined && !needsServices(area)) {
  console.log(`test:all — the ${area} area, with coverage to judge, with no service`);
  process.exit(await runArea(area, []));
}

if (url !== '' && (await reachable(url))) {
  // The shared adapters' tests need a Redis, which a developer who works on nothing else need not run
  // (self-hosting has none, D-7). Left out loudly; in CI there is one, and its absence is a failure.
  const redisHere = redisUrl !== '' && (await reachable(redisUrl));
  if (inCi && !redisHere) {
    console.error(
      'test:all — REDIS_URL is not set or nothing answers there, and CI provides Redis. Refusing to report half a suite.',
    );
    process.exit(1);
  }
  if (!redisHere) {
    console.log(
      [
        '',
        '════════════════════════════════════════════════════════════════════════',
        '  REDIS TESTS NOT RUN — REDIS_URL is not set or nothing answers there.',
        '  The shared bus, limiters and presence are untested by this run: not the gate CI runs.',
        '  Start one and run again:  bun run db:up:redis  (REDIS_URL in .env.test)',
        '════════════════════════════════════════════════════════════════════════',
        '',
      ].join('\n'),
    );
  }
  const redisLeftOut = redisHere
    ? []
    : ['--path-ignore-patterns', '**/*.redis.integration.test.ts'];
  if (area !== undefined) {
    console.log(`test:all — the ${area} area, with coverage to judge (${new URL(url).host})`);
    process.exit(await runArea(area, redisLeftOut));
  }
  console.log(`test:all — unit and integration, with coverage (${new URL(url).host})`);
  process.exit(run([...ROOTS, '--coverage', ...redisLeftOut]));
}

const reason = url === '' ? 'DATABASE_URL is not set' : `nothing answers at ${new URL(url).host}`;
if (area !== undefined) {
  // Never the unit tests alone under an area's name: that would be a part of a suite nobody asked for.
  console.error(
    `test:all — PURLAY_TEST_AREA=${area} needs the database, and ${reason}. Refusing to run another suite in its place.`,
  );
  process.exit(1);
}
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
