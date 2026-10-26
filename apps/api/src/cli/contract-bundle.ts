/**
 * Write the contract bundle (D-192) to a directory, or check a directory against what the repository would write.
 *
 *   bun run contract:bundle --out DIR      write it, replacing what is there
 *   bun run contract:bundle --check DIR    fail if DIR is not exactly this commit's bundle
 *
 * `--check` is exact in both directions: a file missing, a file that differs, and a file that should not be there
 * are each a failure, because a client pins the bundle and a bundle with an extra file is not the bundle.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { assembleBundle } from '../contract/bundle';

const filesUnder = (root: string, at = root): string[] =>
  readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(root, join(at, entry.name))
      : [relative(root, join(at, entry.name)).split('\\').join('/')],
  );

export const writeBundle = (bundle: ReadonlyMap<string, string>, out: string): void => {
  rmSync(out, { recursive: true, force: true });
  for (const [path, text] of bundle) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
};

/** What is wrong with `dir` as a copy of `bundle`, one line each; empty when it is the bundle. */
export const bundleProblems = (bundle: ReadonlyMap<string, string>, dir: string): string[] => {
  const problems: string[] = [];
  let present: string[];
  try {
    present = filesUnder(dir);
  } catch {
    return [`${dir} cannot be read`];
  }
  for (const [path, text] of bundle) {
    if (!present.includes(path)) problems.push(`missing: ${path}`);
    else if (readFileSync(join(dir, path), 'utf8') !== text) problems.push(`differs: ${path}`);
  }
  for (const path of present) if (!bundle.has(path)) problems.push(`unexpected: ${path}`);
  return problems;
};

const main = (argv: readonly string[]): number => {
  const bundle = assembleBundle('.');
  const checkAt = argv.indexOf('--check');
  if (checkAt !== -1) {
    const dir = argv[checkAt + 1];
    if (dir === undefined) {
      console.error('usage: contract:bundle --check DIR');
      return 2;
    }
    const problems = bundleProblems(bundle, dir);
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) return 1;
    console.log(`${dir} is this commit's bundle (${String(bundle.size)} files)`);
    return 0;
  }
  const outAt = argv.indexOf('--out');
  const out = outAt === -1 ? undefined : argv[outAt + 1];
  if (out === undefined) {
    console.error('usage: contract:bundle --out DIR | --check DIR');
    return 2;
  }
  writeBundle(bundle, out);
  console.log(`wrote ${String(bundle.size)} files to ${out}`);
  return 0;
};

if (import.meta.main) process.exit(main(process.argv.slice(2)));
