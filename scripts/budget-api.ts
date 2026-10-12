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
 * Starts the API against this database, waits until it is ready and has settled, and answers its
 * resident memory in bytes. Throws when it never becomes ready: a budget that was not taken.
 */
export const measureIdleRss = async (url: string): Promise<number> => {
  const port = await freePort();
  const api = Bun.spawn(['bun', 'apps/api/src/index.ts'], {
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

/** The command: what it says, and whether it fails — with the database it is given, or none. */
export const main = async (
  environment: Readonly<Record<string, string | undefined>>,
  measure: (url: string) => Promise<number> = measureIdleRss,
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
