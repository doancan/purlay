/**
 * The API's idle memory, measured (`PRD.md` §5, D-49, #73).
 *
 *   bun run budget:api     start the API, wait until it is ready and settled, read its RSS;
 *                          exit 1 at or above the budget
 *
 * One of the two budgets D-49 lets block a merge, because it is stable enough to threshold: a real
 * process, started the way the image starts it — migrations on, against a real database — then left
 * alone for a moment before its resident memory is read. It needs `DATABASE_URL`; without one it says
 * so, and in CI, where the database is provided, it refuses rather than report a budget it never took.
 * The API is started on a clone of the test template made from that server, dropped afterwards —
 * never on the database `DATABASE_URL` names, which it would migrate and write settings into.
 */
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { reachable } from './database-reachable';

export const BUDGET_BYTES = 120 * 1024 * 1024;
const MIB = 1024 * 1024;
/** How long after readiness the process is left alone before it is measured. */
const SETTLE_MS = 3_000;
const READY_WITHIN_MS = 60_000;

const mib = (bytes: number): string => (bytes / MIB).toFixed(1);

export const judge = (rss: number): { readonly ok: boolean; readonly line: string } =>
  rss < BUDGET_BYTES
    ? {
        ok: true,
        line: `API idle RSS: ${mib(rss)} MiB of 120 MiB (${mib(BUDGET_BYTES - rss)} MiB to spare)`,
      }
    : {
        ok: false,
        line: `API idle RSS: ${mib(rss)} MiB of 120 MiB — ${mib(rss - BUDGET_BYTES)} MiB over (PRD.md §5)`,
      };

/** A port nothing is listening on, found by asking the system for one. */
export const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  server.close();
  if (address === null || typeof address === 'string')
    throw new Error('the system gave no free port');
  return address.port;
};

/** The resident set of a process, in bytes, as `ps` reports it (kilobytes) on Linux and macOS. */
export const rssOf = (pid: number): number => {
  const out = Bun.spawnSync(['ps', '-o', 'rss=', '-p', String(pid)])
    .stdout.toString()
    .trim();
  const kilobytes = Number(out);
  if (!Number.isFinite(kilobytes) || kilobytes <= 0)
    throw new Error(`ps gave no RSS for ${String(pid)}`);
  return kilobytes * 1024;
};

/**
 * The name a clone of the test template has (`cloneIntegrationDatabase`): the source's name and twelve
 * hexadecimal digits of its own. Nothing else is a database this command may migrate and fill.
 */
const CLONE_NAME = /_[0-9a-f]{12}$/;

/**
 * Why the API must not be started against this database, or nothing. It starts with migrations on and
 * imports the environment into the server's settings, so against the database a developer works in it
 * would migrate it past the branch they have checked out and write a settings row there (D-179 §4.9).
 */
export const throwawayDatabaseProblem = (url: string): string | undefined => {
  const name = new URL(url).pathname.slice(1);
  return CLONE_NAME.test(name)
    ? undefined
    : `"${name}" is not a throwaway database: the API is started only on a clone of the test template`;
};

/**
 * Starts the API against this database — a clone, refused otherwise before anything starts — waits until
 * it is ready and has settled, and answers its resident memory in bytes. Throws when it never becomes
 * ready: a budget that was not taken.
 */
export const measureIdleRss = async (url: string): Promise<number> => {
  const problem = throwawayDatabaseProblem(url);
  if (problem !== undefined) throw new Error(problem);
  const port = await freePort();
  const api = Bun.spawn(['bun', '--no-env-file', 'apps/api/src/index.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      APP_URL: `http://localhost:${String(port)}`,
      DATABASE_URL: url,
      GITHUB_CLIENT_ID: 'budget',
      GITHUB_CLIENT_SECRET: 'budget',
      // Random each run: the loader refuses a key that looks like a pattern.
      ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      MIGRATE_ON_START: 'true',
      LOG_LEVEL: 'warn',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  try {
    let ready = false;
    const deadline = Date.now() + READY_WITHIN_MS;
    while (!ready && Date.now() < deadline && api.exitCode === null) {
      ready = await fetch(`http://localhost:${String(port)}/health/ready`).then(
        (response) => response.ok,
        () => false,
      );
      if (!ready) await Bun.sleep(250);
    }
    if (!ready)
      throw new Error('the API did not become ready, so its memory could not be measured');
    await Bun.sleep(SETTLE_MS);
    return rssOf(api.pid);
  } finally {
    api.kill('SIGTERM');
    await api.exited;
  }
};

/** The API's command that makes and drops a clone: this file cannot import the database package. */
const THROWAWAY = 'apps/api/src/cli/throwaway-database.ts';

/** What `onAClone` reaches the machine through: a test replaces each, and nothing real is spawned. */
export interface CloneWorld {
  readonly spawn: (command: readonly string[]) => {
    readonly exitCode: number | null;
    readonly stdout: { toString: () => string };
  };
  readonly exit: (code: number) => never;
  readonly signals: {
    readonly once: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => unknown;
    readonly off: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => unknown;
  };
}

const realWorld: CloneWorld = {
  spawn: (command) => Bun.spawnSync([...command], { stderr: 'inherit' }),
  exit: process.exit.bind(process),
  signals: process,
};

/**
 * `body`, given a clone of the test template made from the server `DATABASE_URL` names; the clone is
 * dropped afterwards, whatever `body` did, and when the process is interrupted while `body` runs.
 */
export const onAClone = async <T>(
  body: (url: string) => Promise<T>,
  world: CloneWorld = realWorld,
): Promise<T> => {
  const made = world.spawn(['bun', '--no-env-file', THROWAWAY, 'clone']);
  const url = made.stdout.toString().trim().split('\n').at(-1) ?? '';
  if (made.exitCode !== 0 || url === '') {
    throw new Error('a clone of the test template could not be made to start the API on');
  }
  const name = new URL(url).pathname.slice(1);
  const drop = (): void => {
    const dropped = world.spawn(['bun', '--no-env-file', THROWAWAY, 'drop', name]);
    // A clone left behind is said, not swallowed: it is a whole database on the developer's server.
    if (dropped.exitCode !== 0) {
      console.error(`budget:api — could not drop the clone "${name}"; drop it by hand.`);
    }
  };
  // An interrupt must not strand the clone: drop it first, then leave as the signal asked.
  const interrupted = (code: number) => (): never => {
    drop();
    return world.exit(code);
  };
  const onInt = interrupted(130);
  const onTerm = interrupted(143);
  world.signals.once('SIGINT', onInt);
  world.signals.once('SIGTERM', onTerm);
  try {
    return await body(url);
  } finally {
    world.signals.off('SIGINT', onInt);
    world.signals.off('SIGTERM', onTerm);
    drop();
  }
};

/**
 * The measurement on a clone, dropped afterwards. The address it is given is the server's, which
 * `onAClone` reads from the environment itself; the rest is what a test replaces.
 */
export const measureOnAClone = async (
  _server: string,
  world: CloneWorld = realWorld,
  measure: (url: string) => Promise<number> = measureIdleRss,
): Promise<number> => await onAClone(measure, world);

/** The command: what it says, and whether it fails — with the database it is given, or none. */
export const main = async (
  environment: Readonly<Record<string, string | undefined>>,
  measure: (url: string) => Promise<number> = measureOnAClone,
): Promise<{ readonly line: string; readonly code: number }> => {
  const url = environment['DATABASE_URL'] ?? '';
  if (url === '' || !(await reachable(url))) {
    const reason =
      url === '' ? 'DATABASE_URL is not set' : `nothing answers at ${new URL(url).host}`;
    return environment['CI'] === 'true'
      ? {
          line: `budget:api — ${reason}, and CI provides the database. Refusing to skip a budget.`,
          code: 1,
        }
      : { line: `budget:api — ${reason}: the API's idle memory was NOT measured.`, code: 0 };
  }
  const verdict = judge(await measure(url));
  return { line: verdict.line, code: verdict.ok ? 0 : 1 };
};

if (import.meta.main) {
  const result = await main(process.env);
  (result.code === 0 ? console.log : console.error)(result.line);
  process.exit(result.code);
}
