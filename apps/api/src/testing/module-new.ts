/**
 * `bun run module:new <id> [--requires a,b] [--optional c,d] [--dry-run]`: makes the files of a new module and the
 * lines it adds to the ones that exist (`docs/MODULE-GUIDE.md`, `docs/MODULES.md` §9). Every anchor is looked for before
 * anything is written, a module that exists is left alone, and `--dry-run` says what would be made and changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PRODUCT_MODULE_IDS } from '@purlay/db';
import { RESERVED_MODULE_IDS } from '../platform/module-kit/registry';
import { editsFor } from './module-new/edits';
import { applyEdit, idProblem, namesOf, templateFiles, type Options } from './module-new/plan';

const list = (value: string | undefined): string[] =>
  value === undefined || value === '' ? [] : value.split(',').map((item) => item.trim());

/** The command's words: `<id>` and the flags it knows; anything else is refused. */
export const parseArguments = (
  argv: readonly string[],
): { id: string; options: Options; dryRun: boolean } | string => {
  const flags: Record<string, string> = {};
  const words: string[] = [];
  let dryRun = false;
  for (let at = 0; at < argv.length; at += 1) {
    const word = argv[at] ?? '';
    if (word === '--dry-run') dryRun = true;
    else if (word === '--requires' || word === '--optional') flags[word] = argv[(at += 1)] ?? '';
    else if (word.startsWith('-')) return `unknown flag ${word}`;
    else words.push(word);
  }
  const [id, ...extra] = words;
  if (id === undefined || extra.length > 0)
    return 'usage: bun run module:new <id> [--requires a,b] [--optional c,d] [--dry-run]';
  return {
    id,
    dryRun,
    options: { requires: list(flags['--requires']), optional: list(flags['--optional']) },
  };
};

/**
 * The new table's types: `db:generate` reads a migrated database, so a clone of the test template is migrated and read and then
 * dropped, as `db:check` does. Without `DATABASE_URL` it says the command instead.
 */
const regenerateSchema = (root: string, say: (line: string) => void): void => {
  const url = process.env['DATABASE_URL'];
  if (url === undefined) {
    say(
      'run `bun run db:check` against a database to regenerate packages/db/src/schema.ts, or `bun run db:generate` on a migrated one',
    );
    return;
  }
  const run = (args: string[], databaseUrl: string): string => {
    const done = Bun.spawnSync(args, {
      cwd: root,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stderr: 'pipe',
    });
    if (done.exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${done.stderr.toString()}`);
    return done.stdout.toString().trim().split('\n').pop() ?? '';
  };
  const throwaway = ['bun', '--no-env-file', 'apps/api/src/cli/throwaway-database.ts'];
  const clone = run([...throwaway, 'clone'], url);
  try {
    run(['bun', '--no-env-file', 'run', 'db:migrate'], clone);
    run(['bun', '--no-env-file', 'run', 'db:generate'], clone);
  } finally {
    run([...throwaway, 'drop', clone.slice(clone.lastIndexOf('/') + 1)], url);
  }
  say('edit  packages/db/src/schema.ts (generated)');
};

export const main = (
  argv: readonly string[],
  root: string,
  say: (line: string) => void,
): number => {
  const parsed = parseArguments(argv);
  if (typeof parsed === 'string') {
    say(parsed);
    return 2;
  }
  const { id, options, dryRun } = parsed;
  const problem = idProblem(id, new Set(PRODUCT_MODULE_IDS), RESERVED_MODULE_IDS);
  if (problem !== undefined && !problem.endsWith('is already a module')) {
    say(problem);
    return 2;
  }
  if (problem !== undefined || existsSync(join(root, 'apps/api/src/features', id))) {
    say(`${id} exists already: nothing to do`);
    return 0;
  }
  const unknown = [...options.requires, ...options.optional].filter(
    (partner) => !PRODUCT_MODULE_IDS.includes(partner),
  );
  if (unknown.length > 0) {
    say(`not modules of this build: ${unknown.join(', ')}`);
    return 2;
  }
  const names = namesOf(id);
  const files = templateFiles(names, options);
  const clash = files.filter((file) => existsSync(join(root, file.path)));
  if (clash.length > 0) {
    say(
      `these files exist already, so nothing was written: ${clash.map((file) => file.path).join(', ')}`,
    );
    return 1;
  }
  const changed = new Map<string, string>();
  try {
    for (const edit of editsFor(names, options)) {
      const content = changed.get(edit.file) ?? readFileSync(join(root, edit.file), 'utf8');
      changed.set(edit.file, applyEdit(content, edit));
    }
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return 1;
  }
  for (const file of files) say(`${dryRun ? 'would make' : 'make'}  ${file.path}`);
  for (const file of changed.keys()) say(`${dryRun ? 'would edit' : 'edit'}  ${file}`);
  if (dryRun) return 0;
  for (const file of files) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.content);
  }
  for (const [file, content] of changed) writeFileSync(join(root, file), content);
  const formattable = [...files.map((file) => file.path), ...changed.keys()].filter((file) =>
    /\.(ts|md|json)$/.test(file),
  );
  const formatted = Bun.spawnSync(['bunx', 'prettier', '--write', ...formattable], {
    cwd: root,
    stdout: 'ignore',
  });
  if (formatted.exitCode !== 0)
    say('prettier could not format what was written: run bun run format');
  regenerateSchema(root, say);
  say(
    'next: fill what scaffold-leftovers.test.ts lists, then bun run check:docs and bun run verify',
  );
  return 0;
};

if (import.meta.main)
  process.exit(main(Bun.argv.slice(2), process.cwd(), (line) => process.stdout.write(`${line}\n`)));
