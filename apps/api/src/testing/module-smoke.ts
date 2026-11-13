/**
 * A module's removal, proven on a real process (D-250 rule 6, `MODULES.md` §8).
 *
 *   bun run modules:smoke
 *
 * For every cell of the matrix (`moduleCells`: the core alone, each module with what it requires, everything), in a
 * database of its own: `bun run db:migrate` with that cell's `MODULES`, the API started with the same value and no
 * migration of its own — the way a deployment runs it — and then every path every module's manifest claims asked for
 * with every method, signed out.
 *
 * - a module the cell leaves out answers each of them the `404` of a path nobody serves, byte for byte what an unknown
 *   path answers (no oracle for which modules an instance runs);
 * - a module the cell runs answers at least one of them with something else (a route that is there asks who is calling);
 *   "at least one", because a route may rightly answer the not-found body to a caller it does not know, and a method it
 *   does not register is a `404` too;
 * - the core is up whatever the cell: ready, and its public handshake answers.
 *
 * The suite itself is not run per cell: its tests build their own composition and read no `MODULES`, so the variable would
 * change nothing in them. This is the one place a whole process is started per value.
 *
 * It lives in `testing/` because it is run as a process and imports the test matrix (`module-cells.ts`), as
 * `fresh-server.ts` does for the browser's setup spec. The paths come from the manifests; nothing here lists a module.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import {
  createDatabase,
  databaseNameFromUrl,
  dropDatabases,
  onDatabase as urlOn,
  scratchDatabaseName,
  sql,
} from '@purlay/db';
import { bundledModules, type BundledModule } from '../composition';
import { systemClock } from '../platform/clock';
import { moduleCells, type ModuleCell } from './module-cells';

/** What the API answered: its status and the whole body, which for a not-found is the same bytes whatever the path. */
export interface Answer {
  readonly status: number;
  readonly body: string;
}

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type Method = (typeof METHODS)[number];

/** The path no module claims and no core route is: what "a path nobody serves" answers. */
export const UNKNOWN_PATH = '/api/no-such-thing/x';

/** A path-parameter value that is well formed whatever a route parses it as, and names nothing. */
const NOTHING = '00000000-0000-7000-8000-000000000000';

/** A path a request can ask for that a template matches: a name becomes an id, a catch-all one segment. */
export const concretePath = (template: string): string =>
  template
    .split('/')
    .map((segment) => (segment.startsWith(':') ? NOTHING : segment === '**' ? 'x' : segment))
    .join('/');

export interface Probe {
  readonly module: string;
  readonly method: Method;
  readonly path: string;
}

/** Every method on every path every module claims, from the manifests. */
export const probesOf = (carried: readonly BundledModule[]): readonly Probe[] =>
  carried.flatMap((module) =>
    (module.manifest.routes ?? []).flatMap((template) =>
      METHODS.map((method) => ({
        module: module.manifest.id,
        method,
        path: concretePath(template),
      })),
    ),
  );

export interface Observation {
  /** What an unknown path answered, signed out. */
  readonly unknown: Answer;
  readonly answers: readonly { readonly probe: Probe; readonly answer: Answer }[];
  /** What the core's own paths answered. */
  readonly core: readonly { readonly path: string; readonly status: number }[];
}

/** What the core must answer in every cell: a process that is up, and its public handshake. */
export const CORE_PATHS = ['/health/ready', '/api/client'] as const;

const same = (left: Answer, right: Answer): boolean =>
  left.status === right.status && left.body === right.body;

/**
 * Every way this cell's process does not match its `MODULES`; empty when it does. `running` is the ids it runs, and
 * `carried` the ids of the build.
 */
export const problemsOf = (
  carried: readonly string[],
  running: readonly string[],
  seen: Observation,
): string[] => {
  const problems: string[] = [];
  if (seen.unknown.status !== 404) {
    problems.push(`an unknown path answered ${String(seen.unknown.status)}, not 404`);
  }
  for (const { path, status } of seen.core) {
    if (status !== 200) problems.push(`the core's ${path} answered ${String(status)}, not 200`);
  }
  for (const id of carried) {
    const own = seen.answers.filter(({ probe }) => probe.module === id);
    if (own.length === 0) {
      problems.push(`${id} claims no path, so nothing shows whether it runs`);
      continue;
    }
    const different = own.filter(({ answer }) => !same(answer, seen.unknown));
    if (running.includes(id)) {
      if (different.length === 0) {
        problems.push(`${id} runs but every path it claims answers as a path nobody serves`);
      }
    } else {
      const [first] = different;
      if (first !== undefined) {
        problems.push(
          `${id} does not run but ${String(different.length)} of its ${String(own.length)} requests were not answered as a path nobody serves, the first ${first.probe.method} ${first.probe.path}: ${String(first.answer.status)} ${first.answer.body}`,
        );
      }
    }
  }
  return problems;
};

const ROOT = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
const READY_WITHIN_MS = 60_000;

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  server.close();
  if (address === null || typeof address === 'string') throw new Error('no free port');
  return address.port;
};

const answerOf = async (port: number, method: string, path: string): Promise<Answer> => {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, {
    method,
    redirect: 'manual',
  });
  return { status: response.status, body: await response.text() };
};

/** The environment of a deployment's two commands: its database and its `MODULES`, and nothing of this machine's. */
const environmentOf = (url: string, setting: string | undefined): Record<string, string> => ({
  PATH: process.env['PATH'] ?? '',
  HOME: process.env['HOME'] ?? '',
  DATABASE_URL: url,
  ...(setting === undefined ? {} : { MODULES: setting }),
});

/** One cell on a real process, in a database of its own that is dropped afterwards. Answers what it saw. */
const observeCell = async (
  cell: ModuleCell,
  base: string,
  name: string,
  probes: readonly Probe[],
): Promise<Observation> => {
  const admin = createDatabase({ connectionString: urlOn(base, 'postgres'), poolSize: 1 });
  try {
    await sql`create database ${sql.id(name)}`.execute(admin);
  } finally {
    await admin.destroy();
  }
  try {
    const url = urlOn(base, name);
    const migrated = Bun.spawnSync(
      [process.execPath, '--no-env-file', 'packages/db/src/cli/migrate.ts'],
      {
        cwd: ROOT,
        env: environmentOf(url, cell.setting),
        stdout: 'ignore',
        stderr: 'inherit',
      },
    );
    if (migrated.exitCode !== 0) throw new Error(`db:migrate failed for ${cell.label}`);
    const port = await freePort();
    const api = Bun.spawn([process.execPath, '--no-env-file', 'apps/api/src/index.ts'], {
      cwd: ROOT,
      env: {
        ...environmentOf(url, cell.setting),
        NODE_ENV: 'development',
        PORT: String(port),
        APP_URL: `http://localhost:${String(port)}`,
        GITHUB_CLIENT_ID: 'smoke',
        GITHUB_CLIENT_SECRET: 'smoke',
        ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        LOG_LEVEL: 'warn',
      },
      stdout: 'ignore',
      stderr: 'inherit',
    });
    try {
      const deadline = systemClock.now().getTime() + READY_WITHIN_MS;
      let ready = false;
      while (!ready && systemClock.now().getTime() < deadline && api.exitCode === null) {
        ready = await answerOf(port, 'GET', '/health/ready').then(
          (answer) => answer.status === 200,
          () => false,
        );
        if (!ready) await Bun.sleep(250);
      }
      if (!ready) throw new Error(`the API did not become ready for ${cell.label}`);
      const answers = [];
      for (const probe of probes) {
        answers.push({ probe, answer: await answerOf(port, probe.method, probe.path) });
      }
      const core = [];
      for (const path of CORE_PATHS) {
        core.push({ path, status: (await answerOf(port, 'GET', path)).status });
      }
      return { unknown: await answerOf(port, 'GET', UNKNOWN_PATH), answers, core };
    } finally {
      api.kill('SIGTERM');
      await api.exited;
    }
  } finally {
    await dropDatabases([name]);
  }
};

/** The command: every cell, each one's verdict said, and whether any failed. */
/** Where the command says what it found: its output is its interface. */
export interface Say {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const stdio: Say = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

export const main = async (
  environment: Readonly<Record<string, string | undefined>>,
  observe: typeof observeCell = observeCell,
  say: Say = stdio,
): Promise<number> => {
  const base = environment['DATABASE_URL'] ?? '';
  if (base === '') {
    say.err('modules:smoke — DATABASE_URL is not set, so no cell was run.');
    return 1;
  }
  const probes = probesOf(bundledModules);
  const carried = bundledModules.map((module) => module.manifest.id);
  const prefix = `${databaseNameFromUrl(base)}_smoke_${randomBytes(4).toString('hex')}`;
  let failed = false;
  for (const [index, cell] of moduleCells(bundledModules).entries()) {
    const seen = await observe(
      cell,
      base,
      scratchDatabaseName(`${prefix}_${String(index)}`),
      probes,
    );
    const problems = problemsOf(carried, cell.ids, seen);
    const asked = String(seen.answers.length);
    if (problems.length === 0) {
      say.out(
        `ok   ${cell.label}: MODULES=${cell.setting ?? '(unset)'}, ${asked} module requests, the core up`,
      );
    } else {
      failed = true;
      say.err(`FAIL ${cell.label}: MODULES=${cell.setting ?? '(unset)'}`);
      for (const problem of problems) say.err(`       ${problem}`);
    }
  }
  return failed ? 1 : 0;
};

if (import.meta.main) process.exit(await main(process.env));
