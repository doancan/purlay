/**
 * A server nobody has set up: a scratch database with the schema and no one in it, GitHub's strict
 * stand-in and a mail relay on loopback ports, and the real API serving the built client on one
 * origin — what a browser run of the setup wizard needs (D-179 §4) and `scripts/demo.ts`, which seeds
 * people, cannot give.
 *
 *   bun run apps/api/src/testing/fresh-server.ts --no-build --db purlay_e2e_fresh --port 4400 --manifest /tmp/fresh.json
 *
 * **It can only ever touch a database it created**, as the demo's rule: the name must start with
 * `purlay_e2e` or `purlay_demo`, and is dropped and recreated on every start.
 *
 * The manifest (`--manifest`, written when the API is ready) carries what a test needs and a person
 * cannot read from the screen: the setup code the API wrote to its log, the credentials the GitHub
 * stand-in knows, and the relay's port. The API has no GitHub and no SMTP of its own: a zero-env
 * boot (Ruling R38), which is the state the wizard exists for.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { aGitHubStub, GITHUB_STUB_CREDENTIALS } from './github-stub';
import { aRelay } from './relay';

const DEVELOPMENT_KEY = 'ZGV2ZWxvcG1lbnQtb25seS1rZXktMzItYnl0ZXMhISE=';
const SAFE_DATABASE = /^purlay_(demo|e2e)[a-z0-9_]*$/;
const DEFAULT_ADMIN = 'postgres://purlay:purlay@localhost:5432/postgres';

const flag = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
};

const databaseName = flag('--db') ?? 'purlay_e2e_fresh';
const port = Number(flag('--port') ?? 4400);
const manifestPath = flag('--manifest');
const build = !process.argv.includes('--no-build');
const root = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');

if (!SAFE_DATABASE.test(databaseName)) {
  process.stderr.write(
    `refusing to use "${databaseName}": only a database named purlay_demo… or purlay_e2e… is ever created here\n`,
  );
  process.exit(1);
}

const adminUrl = ((): string => {
  const source = new URL(process.env['DATABASE_URL'] ?? DEFAULT_ADMIN);
  source.pathname = '/postgres';
  return source.toString();
})();
const databaseUrl = ((): string => {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();
const origin = `http://localhost:${String(port)}`;

const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const run = async (command: string[], env: Record<string, string> = {}): Promise<void> => {
  const child = Bun.spawn(command, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.join(' ')} exited with ${String(code)}`);
};

if (build) {
  say('building the client…');
  await run(['bun', 'run', 'build:web']);
}

say(`recreating ${databaseName}…`);
const admin = new SQL(adminUrl);
// The name was checked against SAFE_DATABASE above; an identifier cannot be a bound parameter.
await admin.unsafe(`drop database if exists ${databaseName} with (force)`);
await admin.unsafe(`create database ${databaseName}`);
await admin.close();
await run(['bun', 'run', 'db:migrate'], { DATABASE_URL: databaseUrl });

const github = aGitHubStub(
  { id: 1, login: 'ayse', name: 'Ayse', email: 'ayse@example.test' },
  {},
  GITHUB_STUB_CREDENTIALS,
);
const githubServed = github.serve(port + 2);
const relay = aRelay();

const directory = mkdtempSync(join(tmpdir(), 'purlay-fresh-'));
const files = join(directory, 'files');
let log = '';
const api = Bun.spawn(['bun', 'run', 'apps/api/src/index.ts'], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    LOG_LEVEL: 'info',
    APP_URL: origin,
    DATABASE_URL: databaseUrl,
    ENCRYPTION_KEY: DEVELOPMENT_KEY,
    STORAGE_DIRECTORY: files,
    GITHUB_URL: githubServed.url,
    GITHUB_API_URL: githubServed.url,
    CLIENT_DIST: join(root, 'apps/web/dist'),
  },
  stdout: 'pipe',
  stderr: 'inherit',
});
// Read the log as it is written: the setup code is in it, and the line is the operator's way to it.
void (async (): Promise<void> => {
  const decoder = new TextDecoder();
  for await (const chunk of api.stdout) {
    const text = decoder.decode(chunk);
    log += text;
    process.stdout.write(text);
  }
})();

const waitFor = async <T>(read: () => T | null): Promise<T> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(100);
  }
  api.kill();
  throw new Error('the API did not become ready');
};

const code = await waitFor(() => /"setupCode":"([A-Za-z0-9-]+)"/.exec(log)?.[1] ?? null);
await waitFor(() => (log.includes('listening') || log.includes('ready') ? true : null));

const manifest = {
  origin,
  database: databaseUrl,
  code,
  github: { ...GITHUB_STUB_CREDENTIALS, url: githubServed.url },
  relay: { port: relay.port },
};
if (manifestPath !== undefined) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
say(`READY ${origin}`);
say(`  setup code: ${code}`);

const stop = (): void => {
  api.kill();
  githubServed.stop();
  relay.stop();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
await api.exited;
stop();
