/**
 * `bun run tokens:generate` writes the generated files; `--check` writes nothing
 * and fails if they differ from what the source would produce.
 *
 * The same pattern as `.env.example` and the database types (D-45): a generated
 * file is committed so it can be read and reviewed, and a check keeps the
 * committed copy from drifting from the source it came from.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { audit } from './audit';
import { emit } from './emit';
import { parseTokens } from './model';

// `--root <dir>` points at another copy of the package (the tests use one, so a damaged
// file can be run through the real CLI without touching the real one).
const rootFlag = process.argv.indexOf('--root');
const given = rootFlag === -1 ? undefined : process.argv[rootFlag + 1];
const root = given === undefined ? new URL('../', import.meta.url) : pathToFileURL(`${given}/`);
const generated = new URL('src/generated/', root);

const fail = (title: string, lines: readonly string[]): never => {
  process.stderr.write(`${title}\n${lines.map((line) => `  - ${line}`).join('\n')}\n`);
  process.exit(1);
};

const parsed = parseTokens(JSON.parse(readFileSync(new URL('tokens.json', root), 'utf8')));
if (!parsed.ok) fail('tokens.json is not a sound token file:', parsed.problems);
const model = parsed.ok ? parsed.model : undefined;
if (model === undefined) process.exit(1);

const unreadable = audit(model);
if (unreadable.length > 0) fail('tokens.json is well formed but not usable:', unreadable);

const files = emit(model);
const check = process.argv.includes('--check');
const differing: string[] = [];
for (const [name, content] of Object.entries(files)) {
  const target = new URL(name, generated);
  const current = existsSync(target) ? readFileSync(target, 'utf8') : undefined;
  if (current === content) continue;
  differing.push(name);
  if (!check) writeFileSync(target, content);
}

if (check && differing.length > 0) {
  fail(
    'The generated token files do not match tokens.json. Run `bun run tokens:generate`:',
    differing,
  );
}
process.stdout.write(
  check
    ? 'tokens: generated files match tokens.json\n'
    : `tokens: ${differing.length === 0 ? 'nothing to write' : `wrote ${differing.join(', ')}`}\n`,
);
