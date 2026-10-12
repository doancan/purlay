/**
 * The demo: a scratch database, a seeded workspace, and the real API serving the built
 * client on one origin — started with one command, thrown away with Ctrl-C.
 *
 *   bun run demo                       build, seed, serve on http://localhost:4173
 *   bun run demo -- --no-build         serve the build that is already in apps/web/dist
 *   bun run demo -- --port 4200 --db purlay_demo_two --manifest /tmp/world.json
 *
 * **It can only ever touch a database it created.** The name must start with
 * `purlay_demo` or `purlay_e2e`, and it is dropped and recreated on every start — so
 * the one database a developer actually works in cannot be named here by accident, and a
 * demo is the same demo every time.
 *
 * Why not `vite dev`: the demo is for seeing the product the way it is deployed — a
 * production build, one origin, the socket's `Origin` equal to the page's — and for the
 * browser tests to run against exactly that (D-61).
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { startFront } from './demo-server';

const DEVELOPMENT_KEY = 'ZGV2ZWxvcG1lbnQtb25seS1rZXktMzItYnl0ZXMhISE=';
const SAFE_DATABASE = /^purlay_(demo|e2e)[a-z0-9_]*$/;
const DEFAULT_ADMIN = 'postgres://purlay:purlay@localhost:5432/postgres';

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};
const has = (name: string): boolean => process.argv.includes(name);

const databaseName = flag('--db') ?? 'purlay_demo';
const port = Number(flag('--port') ?? 4173);
const apiPort = port + 1;
const manifestPath = flag('--manifest');
const build = !has('--no-build');
const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

if (!SAFE_DATABASE.test(databaseName)) {
  process.stderr.write(
    `refusing to use "${databaseName}": the demo only ever creates a database named purlay_demo… or purlay_e2e…\n`,
  );
  process.exit(1);
}

const adminUrl = ((): string => {
  const source = new URL(process.env['DATABASE_URL'] ?? DEFAULT_ADMIN);
  source.pathname = '/postgres';
  return source.toString();
})();
const demoUrl = ((): string => {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();
const origin = `http://localhost:${String(port)}`;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const run = async (command: string[], env: Record<string, string> = {}): Promise<void> => {
  const process_ = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await process_.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} exited with ${String(code)}`);
};

// ── 1. The client ────────────────────────────────────────────────────────────
if (build) {
  say('building the client…');
  await run(['bun', 'run', 'build:web']);
}

// ── 2. A fresh database ──────────────────────────────────────────────────────
say(`recreating ${databaseName}…`);
const admin = new SQL(adminUrl);
// The name was checked against SAFE_DATABASE above, so it is safe to put in the statement;
// an identifier cannot be a bound parameter.
await admin.unsafe(`drop database if exists ${databaseName} with (force)`);
await admin.unsafe(`create database ${databaseName}`);
await admin.close();

await run(['bun', 'run', 'db:migrate'], { DATABASE_URL: demoUrl });

// ── 3. The seed ──────────────────────────────────────────────────────────────
const directory = mkdtempSync(join(tmpdir(), 'purlay-demo-'));
const seeded = manifestPath ?? join(directory, 'world.json');
say('seeding the workspace through the API…');
await run(['bun', 'run', 'apps/api/src/cli/seed-demo.ts', '--out', seeded], {
  DATABASE_URL: demoUrl,
  APP_URL: origin,
});
const world = JSON.parse(readFileSync(seeded, 'utf8')) as {
  personas: Record<string, { token: string }>;
};
const sessions = Object.fromEntries(
  Object.entries(world.personas).map(([name, persona]) => [name, persona.token]),
);

// ── 4. The API ───────────────────────────────────────────────────────────────
// Attachments: the bucket when one is configured (`bun run db:up`); otherwise a directory of this
// run's own, thrown away with its database on the next start (D-117), so an upload works here too.
const files =
  process.env['S3_ENDPOINT'] === undefined || process.env['S3_ENDPOINT'] === ''
    ? join(tmpdir(), `purlay-files-${databaseName}`)
    : null;
if (files !== null) {
  rmSync(files, { recursive: true, force: true });
  say(`attachments are kept in ${files}`);
}
say(`starting the API on :${String(apiPort)}…`);
const api = Bun.spawn(['bun', 'run', 'apps/api/src/index.ts'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(apiPort),
    LOG_LEVEL: 'warn',
    APP_URL: origin,
    DATABASE_URL: demoUrl,
    GITHUB_CLIENT_ID: 'demo',
    GITHUB_CLIENT_SECRET: 'demo',
    ENCRYPTION_KEY: DEVELOPMENT_KEY,
    ...(files === null ? {} : { STORAGE_DIRECTORY: files }),
    // The API serves the build itself, as the image does (D-61).
    CLIENT_DIST: join(root, 'apps/web/dist'),
  },
  stdout: 'inherit',
  stderr: 'inherit',
});

const ready = async (): Promise<boolean> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://localhost:${String(apiPort)}/health/ready`);
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  return false;
};
if (!(await ready())) {
  api.kill();
  throw new Error('the API did not become ready');
}

// ── 5. One origin ────────────────────────────────────────────────────────────
const front = startFront({
  api: `http://localhost:${String(apiPort)}`,
  sessions,
  port,
});

// Parsed by the browser tests' web-server wait; keep it one line.
say(`READY ${origin}`);
say('');
say('  Sign in as a demo person (GitHub is not reachable from here):');
for (const name of Object.keys(sessions)) say(`    ${origin}/__demo/login?as=${name}`);
say('');
say('  Chromium or Firefox: the session cookie is Secure, which they accept on localhost.');
say('  Ctrl-C stops everything. The database is thrown away on the next start.');

const stop = async (): Promise<void> => {
  api.kill();
  await front.stop(true);
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
// Keeps a manifest a test wrote readable after exit; nothing else is left behind.
if (manifestPath !== undefined) writeFileSync(`${manifestPath}.ready`, origin);
await api.exited;
await stop();
