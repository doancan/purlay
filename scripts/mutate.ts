/**
 * Mutation testing, by hand-picked mutations (`CONTRIBUTING.md` §5).
 *
 * Coverage says a line ran, not that anything would notice if it were wrong. A
 * mutation is a small, deliberate wrongness — a guard removed, a limit raised, a
 * call moved — and a test that does not fail on it is not testing that behaviour.
 * The list lives in `scripts/mutations.ts`; each entry names the test files that
 * must catch it.
 *
 * **Never the working tree.** The repository is copied once into a temporary
 * directory (everything but `.git` and `node_modules`; the root `node_modules` is
 * linked, the workspaces' own are copied because their links to `packages/*` must
 * point at the *copy*), each mutation is applied there, the tests are run, and the
 * file is restored. A crash leaves the working tree exactly as it was.
 *
 * **A mutation that no longer applies is a failure, not a skip.** `find` must occur
 * exactly once; code that moved or was reworded makes the entry stale, and a stale
 * entry that passed silently would report a mutation it never made as caught.
 * Likewise the unmutated tests must pass first, or "the tests failed" would prove
 * nothing.
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Mutation {
  readonly id: string;
  /** What is wrong with the mutated code, and who would be hurt. */
  readonly why: string;
  readonly file: string;
  /** Occurs exactly once in `file`. */
  readonly find: string;
  readonly replace: string;
  /** Test files (or directories) that must fail on it. */
  readonly tests: readonly string[];
  /** Set only for a mutation that cannot change behaviour; says why. Not counted as a survivor. */
  readonly equivalent?: string;
}

type Outcome = 'caught' | 'survived' | 'stale' | 'equivalent';

export interface Verdict {
  readonly id: string;
  readonly outcome: Outcome;
  readonly detail: string;
}

export interface Options {
  readonly root: string;
  readonly mutations: readonly Mutation[];
  /** The test command; the mutation's test files are appended. */
  readonly command?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Longest a run may take. A mutation that hangs the tests is caught by them. */
  readonly timeoutMs?: number;
}

/** A copy of the repository that mutations may be written to. */
const copyTree = (root: string): string => {
  const copy = mkdtempSync(join(tmpdir(), 'purlay-mutate-'));
  cpSync(root, copy, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (source) => {
      const relative = source.slice(root.length + 1);
      return relative !== '.git' && relative !== 'node_modules' && relative !== '.tsbuild';
    },
  });
  const modules = join(root, 'node_modules');
  if (existsSync(modules)) symlinkSync(modules, join(copy, 'node_modules'));
  return copy;
};

/** The file's text with the one occurrence replaced, or `undefined` when it is not exactly one. */
export const mutate = (text: string, mutation: Mutation): string | undefined => {
  const first = text.indexOf(mutation.find);
  if (!text.includes(mutation.find) || text.lastIndexOf(mutation.find) !== first) return undefined;
  return text.slice(0, first) + mutation.replace + text.slice(first + mutation.find.length);
};

const run = (
  copy: string,
  command: readonly string[],
  tests: readonly string[],
  env: Options['env'],
  timeoutMs: number,
): { passed: boolean; output: string } => {
  const process = Bun.spawnSync([...command, ...tests], {
    cwd: copy,
    env: { ...Bun.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  });
  const output = process.stdout.toString() + process.stderr.toString();
  return { passed: process.exitCode === 0 && !process.exitedDueToTimeout, output };
};

export const runMutations = (options: Options): Verdict[] => {
  const command = options.command ?? ['bun', '--no-env-file', '--env-file=.env.test', 'test'];
  const timeoutMs = options.timeoutMs ?? 180_000;
  const root = resolve(options.root);
  const copy = copyTree(root);
  try {
    const baseline = run(
      copy,
      command,
      [...new Set(options.mutations.flatMap((m) => m.tests))],
      options.env,
      timeoutMs,
    );
    if (!baseline.passed) {
      throw new Error(
        `the tests fail before any mutation, so a failure would prove nothing:\n${baseline.output.slice(-2000)}`,
      );
    }

    return options.mutations.map((mutation): Verdict => {
      const path = join(copy, mutation.file);
      const original = readFileSync(path, 'utf8');
      const mutated = mutate(original, mutation);
      if (mutated === undefined) {
        return {
          id: mutation.id,
          outcome: 'stale',
          detail: `\`find\` does not occur exactly once in ${mutation.file}`,
        };
      }
      writeFileSync(path, mutated);
      try {
        const result = run(copy, command, mutation.tests, options.env, timeoutMs);
        if (result.passed && mutation.equivalent !== undefined) {
          return { id: mutation.id, outcome: 'equivalent', detail: mutation.equivalent };
        }
        return result.passed
          ? { id: mutation.id, outcome: 'survived', detail: 'every test still passed' }
          : { id: mutation.id, outcome: 'caught', detail: 'a test failed' };
      } finally {
        writeFileSync(path, original);
      }
    });
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
};

/** Whether the verdicts are acceptable: nothing survived, nothing stale. */
export const acceptable = (verdicts: readonly Verdict[]): boolean =>
  verdicts.every((v) => v.outcome === 'caught' || v.outcome === 'equivalent');

export const report = (verdicts: readonly Verdict[]): string => {
  const count = (outcome: Outcome): number => verdicts.filter((v) => v.outcome === outcome).length;
  const lines = verdicts.map(
    (v) => `${v.outcome.padEnd(10)} ${v.id}${v.outcome === 'caught' ? '' : ` — ${v.detail}`}`,
  );
  lines.push(
    '',
    `${String(verdicts.length)} mutations: ${String(count('caught'))} caught, ${String(count('survived'))} survived, ` +
      `${String(count('stale'))} stale, ${String(count('equivalent'))} equivalent`,
  );
  return lines.join('\n');
};
