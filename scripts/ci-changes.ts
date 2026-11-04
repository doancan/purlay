/**
 * Whether a change can move what the browser tests see — and so whether CI spends its four browser
 * jobs on it — and whether it can move what a process started with a given `MODULES` answers, which is
 * what the `modules` job starts (`bun run modules:smoke`). A pull request that changes only documents, scripts or another workflow cannot change a
 * screen; one that touches the client, the API it talks to, a package or the dependencies can. On
 * main they always run.
 *
 *   bun run ci:changes        in CI: reads the pull request's files and writes `browser=…` and `modules=…` to its output
 */
import { appendFileSync } from 'node:fs';

/** Paths a screen depends on: the client, the API behind it, the shared packages, the dependencies. */
const BROWSER =
  /^(apps\/web\/|apps\/api\/|packages\/|package\.json$|bun\.lock$|\.github\/workflows\/ci\.yml$)/;

/**
 * Paths a process's answers depend on: the API, the packages it is built from (the one that migrates it among them),
 * the dependencies, the smoke itself (it is under `apps/api/`) and the workflow that runs it. Not the client.
 */
const MODULES = /^(apps\/api\/|packages\/|package\.json$|bun\.lock$|\.github\/workflows\/ci\.yml$)/;

export const needsModules = (event: string, files: readonly string[]): boolean =>
  event !== 'pull_request' || files.some((file) => MODULES.test(file));

export const needsBrowser = (event: string, files: readonly string[]): boolean =>
  event !== 'pull_request' || files.some((file) => BROWSER.test(file));

type Run = (command: readonly string[]) => { exitCode: number; stdout: string; stderr: string };

export const run: Run = (command) => {
  const done = Bun.spawnSync([...command]);
  return {
    exitCode: done.exitCode,
    stdout: done.stdout.toString(),
    stderr: done.stderr.toString(),
  };
};

/** The pull request's changed files, as GitHub lists them. */
export const filesOf = (repository: string, number: string, spawn: Run = run): string[] => {
  const listed = spawn([
    'gh',
    'api',
    `repos/${repository}/pulls/${number}/files`,
    '--paginate',
    '--jq',
    '.[].filename',
  ]);
  if (listed.exitCode !== 0) {
    throw new Error(`the pull request's files could not be read: ${listed.stderr}`);
  }
  return listed.stdout.split('\n').filter(Boolean);
};

/** The lines CI reads: written to `GITHUB_OUTPUT` when there is one, and returned. */
export const main = (
  environment: Readonly<Record<string, string | undefined>>,
  spawn: Run = run,
): string => {
  const event = environment['EVENT'] ?? '';
  const files =
    event === 'pull_request'
      ? filesOf(environment['REPOSITORY'] ?? '', environment['NUMBER'] ?? '', spawn)
      : [];
  const lines = [
    `browser=${String(needsBrowser(event, files))}`,
    `modules=${String(needsModules(event, files))}`,
  ].join('\n');
  const output = environment['GITHUB_OUTPUT'];
  if (output !== undefined) appendFileSync(output, `${lines}\n`);
  return lines;
};

if (import.meta.main) console.log(main(process.env));
