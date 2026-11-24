/**
 * What a run has to prove, said once before the heavy jobs start (D-332): whether the change is *light*, and whether
 * the commit on main is one whose content was *already verified*. The two let the pipeline stop spending twenty-six
 * minutes on what a smaller proof already covers, and neither lowers what a change must pass:
 *
 * - **light** (pull requests): every changed file is a document, or `package.json` with its version line the only
 *   line that moved. No source, test, script, workflow or dependency changed, so no test of the code can have a
 *   different answer. What can read a document is a test that needs no database, so `light-suite` runs every one of
 *   those, in place of `schema`'s coverage run of all of them. Anything else — a single other file, a `package.json`
 *   change that is not the version, a patch GitHub did not send — is not light, and gets everything.
 * - **reuse** (pushes to main): the commit's tree is the tree of a pull request's head whose own `verify` succeeded
 *   with the heavy jobs *run*, not skipped — the same content, proven by the same jobs. Or the commit is a light
 *   change on top of a base that is itself reused (a release: version and notes on a tested tree), to depth
 *   `DEPTH`. A rebase that changed the tree (main moved) matches nothing and gets the full run, as before.
 *
 *   bun run ci:scope        in CI: writes `light=…` and `reuse=…` to its output
 */
import { appendFileSync } from 'node:fs';
import { run, type Run } from './ci-changes';

/** Documents a test can read, and that no code reads as input to anything but a test: `docs/` and the root `*.md`. */
const DOCUMENT = /^(docs\/|[^/]+\.md$)/;

/** A path that climbs out of where it starts is not what it names: GitHub never sends one, and none is believed. */
const climbs = (name: string): boolean =>
  name.split('/').some((part) => part === '..' || part === '.');

/** The jobs that must have *run* — not been skipped for a path — for a pull request to be proof of its tree. */
export const HEAVY = ['static', 'schema', 'browser', 'module-suites'] as const;

/** How far a light change may be traced back to a verified base: a release on a tested tree is one. */
export const DEPTH = 3;

export interface ChangedFile {
  readonly filename: string;
  readonly previous_filename?: string | undefined;
  readonly patch?: string | undefined;
}

/**
 * Whether a patch of `package.json` moves the version line and nothing else: one removed and one added line, both
 * `"version": "x.y.z"`, and no other `+` or `-` line.
 */
export const movesOnlyTheVersion = (patch: string | undefined): boolean => {
  if (patch === undefined) return false;
  const changed = patch
    .split('\n')
    .filter((line) => /^[+-]/.test(line) && !line.startsWith('+++') && !line.startsWith('---'));
  const version = /^[+-]\s*"version":\s*"\d+\.\d+\.\d+"\s*,?\s*$/;
  return (
    changed.length === 2 &&
    changed.every((line) => version.test(line)) &&
    changed.some((line) => line.startsWith('-')) &&
    changed.some((line) => line.startsWith('+'))
  );
};

export const isLight = (files: readonly ChangedFile[]): boolean =>
  files.length > 0 &&
  files.every((file) => {
    const named = [file.filename, file.previous_filename].filter(
      (name): name is string => name !== undefined,
    );
    if (named.every((name) => DOCUMENT.test(name) && !climbs(name))) return true;
    return (
      named.length === 1 && file.filename === 'package.json' && movesOnlyTheVersion(file.patch)
    );
  });

const ask = (spawn: Run, args: readonly string[]): string => {
  const done = spawn(['gh', 'api', ...args]);
  if (done.exitCode !== 0) throw new Error(`gh api ${args.join(' ')} failed: ${done.stderr}`);
  return done.stdout.trim();
};

/** A file as `gh` writes it: a field GitHub left out is `null`, where `ChangedFile` leaves it out. */
interface RawChangedFile {
  readonly filename: string;
  readonly previous_filename: string | null;
  readonly patch: string | null;
}

const changedFileOf = (raw: RawChangedFile): ChangedFile => ({
  filename: raw.filename,
  previous_filename: raw.previous_filename ?? undefined,
  patch: raw.patch ?? undefined,
});

/** The files of a pull request, with their patches. */
export const filesWithPatches = (
  repository: string,
  number: string,
  spawn: Run = run,
): ChangedFile[] => {
  const listed = ask(spawn, [
    `repos/${repository}/pulls/${number}/files`,
    '--paginate',
    '--jq',
    '.[] | {filename, previous_filename, patch} | tojson',
  ]);
  return listed
    .split('\n')
    .filter(Boolean)
    .map((line) => changedFileOf(JSON.parse(line) as RawChangedFile));
};

interface Evidence {
  /** `full` when every heavy job ran and succeeded; `light` when the light suite did. */
  readonly kind: 'full' | 'light';
  readonly base: string;
}

/** How long GitHub is given to say which pull request a commit just merged from, and how often it is asked. */
export const ASSOCIATION_WAITS = [5, 10, 15] as const;

/**
 * The merged pull requests a commit on main belongs to, as `number head base`. GitHub links a commit to its pull
 * request a few seconds after the merge, so an empty answer is asked again, a few times: giving up at once would
 * only cost the full run, but waiting a little usually saves it.
 */
const pullsOf = (
  repository: string,
  commit: string,
  spawn: Run,
  sleep: (seconds: number) => void,
): string[][] => {
  for (let attempt = 0; ; attempt += 1) {
    const found = ask(spawn, [
      `repos/${repository}/commits/${commit}/pulls`,
      '--jq',
      '.[] | select(.merged_at != null) | "\\(.number) \\(.head.sha) \\(.base.sha)"',
    ])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' '));
    const wait = ASSOCIATION_WAITS[attempt];
    if (found.length > 0 || wait === undefined) return found;
    sleep(wait);
  }
};

const treeOfCommit = (repository: string, commit: string, spawn: Run): string =>
  ask(spawn, [`repos/${repository}/git/commits/${commit}`, '--jq', '.tree.sha']);

/**
 * Whether a job *ran and succeeded*: a plain job by its name, a matrix by every one of its legs, which GitHub names
 * `browser (chromium-dark, suite)`. A name with no job, and a matrix with one leg that did not succeed, did not run.
 */
const ran = (jobs: ReadonlyMap<string, string>, name: string): boolean => {
  const legs = [...jobs].filter(([job]) => job === name || job.startsWith(`${name} (`));
  return legs.length > 0 && legs.every(([, conclusion]) => conclusion === 'success');
};

/** What a pull request's own newest finished `ci` run proved about its head, or null when it proved nothing. */
const evidenceOf = (
  repository: string,
  head: string,
  base: string,
  spawn: Run,
): Evidence | null => {
  const id = ask(spawn, [
    `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${head}&event=pull_request&per_page=20`,
    '--jq',
    '[.workflow_runs[] | select(.status == "completed")] | sort_by(.created_at) | last | .id // empty',
  ]);
  if (id === '') return null;
  const jobs = new Map(
    ask(spawn, [
      `repos/${repository}/actions/runs/${id}/jobs`,
      '--paginate',
      '--jq',
      '.jobs[] | "\\(.name)\\t\\(.conclusion)"',
    ])
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t') as [string, string]),
  );
  if (jobs.get('verify') !== 'success') return null;
  if (HEAVY.every((name) => ran(jobs, name))) return { kind: 'full', base };
  if (jobs.get('light-suite') === 'success' && jobs.get('schema') === 'skipped') {
    return { kind: 'light', base };
  }
  return null;
};

/**
 * Whether the content of `commit` on main was verified before it got there. Never throws a verdict on a read it
 * could not make: an unreadable answer is "no", which is the full run.
 */
export const reuses = (
  repository: string,
  commit: string,
  spawn: Run = run,
  depth: number = DEPTH,
  sleep: (seconds: number) => void = (seconds) => {
    Bun.sleepSync(seconds * 1000);
  },
): boolean => {
  if (depth <= 0) return false;
  try {
    const tree = treeOfCommit(repository, commit, spawn);
    for (const [, head, base] of pullsOf(repository, commit, spawn, sleep)) {
      if (head === undefined || base === undefined) continue;
      if (treeOfCommit(repository, head, spawn) !== tree) continue;
      const evidence = evidenceOf(repository, head, base, spawn);
      if (evidence === null) continue;
      if (evidence.kind === 'full') return true;
      if (reuses(repository, evidence.base, spawn, depth - 1, sleep)) return true;
    }
  } catch {
    return false;
  }
  return false;
};

/** The lines CI reads: written to `GITHUB_OUTPUT` when there is one, and returned. */
export const main = (
  environment: Readonly<Record<string, string | undefined>>,
  spawn: Run = run,
): string => {
  const event = environment['EVENT'] ?? '';
  const repository = environment['REPOSITORY'] ?? '';
  let light = false;
  let reuse = false;
  if (event === 'pull_request') {
    light = isLight(filesWithPatches(repository, environment['NUMBER'] ?? '', spawn));
  } else if (event === 'push' && environment['BRANCH'] === 'main') {
    reuse = reuses(repository, environment['COMMIT'] ?? '', spawn);
  }
  const lines = [`light=${String(light)}`, `reuse=${String(reuse)}`].join('\n');
  const output = environment['GITHUB_OUTPUT'];
  if (output !== undefined) appendFileSync(output, `${lines}\n`);
  return lines;
};

if (import.meta.main) console.log(main(process.env));
