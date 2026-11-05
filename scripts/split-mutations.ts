/**
 * One-off tool that moved `scripts/mutations.ts` into `scripts/mutations/<area>.ts` (the area table is
 * `scripts/mutations/areas.ts`), kept for a short time so a pull request parked on the old file can be
 * folded in. Deleted once nothing is parked.
 *
 *   bun scripts/split-mutations.ts [<ref>]       split <ref>:scripts/mutations.ts (default origin/main) into
 *                                                 scripts/mutations/, and delete scripts/mutations.ts
 *   bun scripts/split-mutations.ts --merge <ref> fold what <ref>'s scripts/mutations.ts changed since its
 *                                                 merge-base with HEAD into the files of scripts/mutations/
 *   bun scripts/split-mutations.ts --verify [<ref>]
 *                                                 prove scripts/mutations/ holds exactly <ref>'s entries
 *
 * It reads the source with the TypeScript parser, never a regular expression, keeps each entry's text
 * exactly as written, and is deterministic: a second run changes nothing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';
import type { Mutation } from './mutate';
import { AREAS, type AreaName, areaOf } from './mutations/areas';

const ROOT = join(import.meta.dir, '..');
const DIRECTORY = join(ROOT, 'scripts', 'mutations');
const OLD_FILE = join(ROOT, 'scripts', 'mutations.ts');
const OLD_PATH = 'scripts/mutations.ts';
const HAND_WRITTEN = ['areas.ts'];
const DEFAULT_REF = 'origin/main';

interface Const {
  readonly name: string;
  /** The comment lines above it. */
  readonly comments: readonly string[];
  /** `const NAME = ...;`, as written. */
  readonly declaration: string;
  readonly references: readonly string[];
  readonly value: ts.Expression;
}

interface Entry {
  readonly id: string;
  readonly comments: readonly string[];
  /** The object literal, exactly as written. */
  readonly text: string;
  readonly references: readonly string[];
  readonly file: string;
}

interface Source {
  /** In the order they were written. */
  readonly consts: Map<string, Const>;
  readonly entries: Map<string, Entry>;
}

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const fail = (message: string): never => {
  throw new Error(message);
};

const commentsBefore = (text: string, position: number): string[] =>
  (ts.getLeadingCommentRanges(text, position) ?? []).map((range) =>
    text.slice(range.pos, range.end),
  );

/** Every identifier but a property's own name; which of them name a constant is for the whole source to say. */
const identifiersIn = (node: ts.Node): string[] => {
  const found = new Set<string>();
  const visit = (child: ts.Node): void => {
    const isPropertyName = ts.isPropertyAssignment(child.parent) && child.parent.name === child;
    if (ts.isIdentifier(child) && !isPropertyName) found.add(child.text);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return [...found].sort();
};

const stringOf = (consts: ReadonlyMap<string, Const>, node: ts.Expression): string => {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const constant = consts.get(node.text) ?? fail(`unknown constant ${node.text}`);
    return stringOf(consts, constant.value);
  }
  return fail(`not a string: ${node.getText()}`);
};

const isEntryList = (declaration: ts.VariableDeclaration): boolean =>
  declaration.type?.getText() === 'readonly Mutation[]' ||
  declaration.name.getText() === 'MUTATIONS';

/** The constants and the entries of one file: the old `mutations.ts`, or one file of the new directory. */
const parse = (
  text: string,
  name: string,
  shared: ReadonlyMap<string, Const> = new Map(),
): Source => {
  const sourceFile = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const pending: { statement: ts.VariableStatement; declaration: ts.VariableDeclaration }[] = [];
  const lists: ts.ArrayLiteralExpression[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (!ts.isVariableStatement(statement)) fail(`${name}: unexpected statement`);
    for (const declaration of (statement as ts.VariableStatement).declarationList.declarations) {
      if (!isEntryList(declaration))
        pending.push({ statement: statement as ts.VariableStatement, declaration });
      else if (declaration.initializer && ts.isArrayLiteralExpression(declaration.initializer)) {
        lists.push(declaration.initializer);
      } else fail(`${name}: the entry list is not an array literal`);
    }
  }
  const consts = new Map<string, Const>();
  for (const { statement, declaration } of pending) {
    const initializer = declaration.initializer ?? fail(`${name}: ${declaration.name.getText()}`);
    const constName = declaration.name.getText();
    consts.set(constName, {
      name: constName,
      comments: commentsBefore(text, statement.getFullStart()),
      declaration: statement.getText().replace(/^export\s+/, ''),
      references: identifiersIn(initializer).filter((other) => other !== constName),
      value: initializer,
    });
  }
  const entries = new Map<string, Entry>();
  for (const list of lists) {
    for (const element of list.elements) {
      if (!ts.isObjectLiteralExpression(element))
        fail(`${name}: an entry is not an object literal`);
      const object = element as ts.ObjectLiteralExpression;
      const property = (key: string): ts.Expression =>
        (
          object.properties.find(
            (candidate) => ts.isPropertyAssignment(candidate) && candidate.name.getText() === key,
          ) as ts.PropertyAssignment | undefined
        )?.initializer ?? fail(`${name}: an entry has no ${key}`);
      const lookup = new Map([...shared, ...consts]);
      const id = stringOf(lookup, property('id'));
      if (entries.has(id)) fail(`${name}: id ${id} appears twice`);
      entries.set(id, {
        id,
        comments: commentsBefore(text, element.getFullStart()),
        text: element.getText(),
        references: identifiersIn(element),
        file: stringOf(lookup, property('file')),
      });
    }
  }
  return { consts, entries };
};

const merged = (parts: readonly Source[]): Source => {
  const consts = new Map<string, Const>();
  const entries = new Map<string, Entry>();
  for (const part of parts) {
    for (const [name, constant] of part.consts) {
      if (consts.has(name)) fail(`constant ${name} is defined in two files`);
      consts.set(name, constant);
    }
    for (const [id, entry] of part.entries) {
      if (entries.has(id)) fail(`id ${id} is in two files`);
      entries.set(id, entry);
    }
  }
  return { consts, entries };
};

const readDirectory = (): Source => {
  const read = (name: string, shared?: ReadonlyMap<string, Const>): Source =>
    parse(readFileSync(join(DIRECTORY, name), 'utf8'), name, shared);
  const names = readdirSync(DIRECTORY).filter(
    (name) => name.endsWith('.ts') && !HAND_WRITTEN.includes(name) && name !== 'index.ts',
  );
  const sharedConsts = names.includes('shared.ts') ? read('shared.ts').consts : new Map();
  return merged(
    names.sort().map((name) => (name === 'shared.ts' ? read(name) : read(name, sharedConsts))),
  );
};

const oldSource = (ref: string): string => git('show', `${ref}:${OLD_PATH}`);

const constantName = (area: string): string => area.toUpperCase().replaceAll('-', '_');

const indent = (lines: readonly string[]): string[] => lines.map((line) => `  ${line}`);

const render = (entries: readonly Entry[]): string =>
  entries.map((entry) => [...indent(entry.comments), `  ${entry.text},`].join('\n')).join('\n');

const header = (area: AreaName): string =>
  `// Area ${area}: ids ascending; areas.ts says what belongs here.`;

const INDEX_HEADER = `/**
 * The mutations \`bun run mutate\` applies (\`scripts/mutate.ts\`, \`CONTRIBUTING.md\` §5).
 *
 * Each is something a reviewer could plausibly let through, written against the code
 * as it is: when the code moves, the entry goes stale and the run says so.
 *
 * An entry goes in the file of the area \`areaOf\` names for the file it mutates
 * (\`areas.ts\`), at the place its id sorts: never at the end of a file, so two pull requests
 * rarely edit the same lines. \`mutations.test.ts\` refuses an entry in the wrong file or out of order,
 * and a file this list does not import. A new area is a line in \`areas.ts\`, a new file, and one
 * import and one line here.
 */`;

/** Writes the directory from \`source\`: deterministic, so a second run changes nothing. */
const write = (source: Source): void => {
  const areaOfEntry = new Map<string, AreaName>();
  const byArea = new Map<AreaName, Entry[]>();
  for (const entry of source.entries.values()) {
    const area = areaOf(entry.file);
    areaOfEntry.set(entry.id, area);
    byArea.set(area, [...(byArea.get(area) ?? []), entry]);
  }

  const areasOfConst = new Map<string, Set<AreaName>>();
  for (const name of source.consts.keys()) areasOfConst.set(name, new Set());
  for (const entry of source.entries.values()) {
    for (const name of entry.references) areasOfConst.get(name)?.add(areaOfEntry.get(entry.id)!);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const constant of source.consts.values()) {
      for (const dependency of constant.references) {
        const target = areasOfConst.get(dependency);
        if (target === undefined) continue;
        for (const area of areasOfConst.get(constant.name)!) {
          if (!target.has(area)) {
            target.add(area);
            changed = true;
          }
        }
      }
    }
  }

  const shared = [...source.consts.values()].filter((c) => areasOfConst.get(c.name)!.size > 1);
  const sharedNames = new Set(shared.map((c) => c.name));
  for (const constant of source.consts.values()) {
    if (areasOfConst.get(constant.name)!.size === 0) fail(`constant ${constant.name} is unused`);
  }

  for (const area of AREAS) {
    if (!byArea.has(area.name)) fail(`area ${area.name} has no entry: remove it from areas.ts`);
  }

  for (const name of readdirSync(DIRECTORY)) {
    if (!HAND_WRITTEN.includes(name)) rmSync(join(DIRECTORY, name));
  }

  const constText = (constant: Const, exported: boolean): string =>
    [...constant.comments, exported ? `export ${constant.declaration}` : constant.declaration].join(
      '\n',
    );

  if (shared.length > 0) {
    const text = shared.map((constant) => constText(constant, true)).join('\n\n');
    writeFileSync(join(DIRECTORY, 'shared.ts'), `${text}\n`);
  }

  for (const area of AREAS) {
    const entries = [...byArea.get(area.name)!].sort((a, b) => (a.id < b.id ? -1 : 1));
    const local = [...source.consts.values()].filter((c) => {
      const areas = areasOfConst.get(c.name)!;
      return areas.size === 1 && areas.has(area.name);
    });
    const used = new Set<string>();
    for (const entry of entries) for (const name of entry.references) used.add(name);
    for (const constant of local) for (const name of constant.references) used.add(name);
    const imports = [...used].filter((name) => sharedNames.has(name)).sort();
    const lines = [
      header(area.name),
      "import type { Mutation } from '../mutate';",
      ...(imports.length > 0 ? [`import { ${imports.join(', ')} } from './shared';`] : []),
      '',
      ...(local.length > 0 ? [local.map((c) => constText(c, false)).join('\n\n'), ''] : []),
      `export const ${constantName(area.name)}: readonly Mutation[] = [`,
      render(entries),
      '];',
    ];
    writeFileSync(join(DIRECTORY, `${area.name}.ts`), `${lines.join('\n')}\n`);
  }

  const importLines = [...AREAS]
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((area) => `import { ${constantName(area.name)} } from './${area.name}';`);
  const record = AREAS.map((area) => `  '${area.name}': ${constantName(area.name)},`);
  writeFileSync(
    join(DIRECTORY, 'index.ts'),
    [
      INDEX_HEADER,
      "import type { Mutation } from '../mutate';",
      "import type { AreaName } from './areas';",
      ...importLines,
      '',
      'export const MUTATIONS_BY_AREA: Readonly<Record<AreaName, readonly Mutation[]>> = {',
      ...record,
      '};',
      '',
      'export const MUTATIONS: readonly Mutation[] = Object.values(MUTATIONS_BY_AREA).flat();',
      '',
    ].join('\n'),
  );
  execFileSync(join(ROOT, 'node_modules', '.bin', 'prettier'), ['--write', DIRECTORY], {
    cwd: ROOT,
    stdio: 'ignore',
  });
};

const split = (ref: string): void => {
  mkdirSync(DIRECTORY, { recursive: true });
  write(parse(oldSource(ref), OLD_PATH));
  rmSync(OLD_FILE, { force: true });
  console.log(`split ${ref}:${OLD_PATH} (${git('rev-parse', `${ref}:${OLD_PATH}`).trim()})`);
};

const foldIn = (ref: string): void => {
  const base = git('merge-base', ref, 'HEAD').trim();
  const before = parse(oldSource(base), `${base}:${OLD_PATH}`);
  const theirs = parse(oldSource(ref), `${ref}:${OLD_PATH}`);
  const tree = readDirectory();
  const note = (message: string): void => {
    console.log(message);
  };

  for (const [name, constant] of theirs.consts) {
    const original = before.consts.get(name)?.declaration;
    const current = tree.consts.get(name)?.declaration;
    if (constant.declaration === original || constant.declaration === current) continue;
    if (current !== undefined && current !== original)
      fail(`constant ${name}: changed on both sides`);
    tree.consts.set(name, constant);
    note(`constant ${name}: ${current === undefined ? 'added' : 'changed'}`);
  }
  for (const [id, entry] of theirs.entries) {
    const original = before.entries.get(id);
    const current = tree.entries.get(id);
    if (original?.text === entry.text && original.comments.join() === entry.comments.join())
      continue;
    if (current?.text === entry.text) continue;
    if (current !== undefined && current.text !== original?.text) {
      fail(`${id}: changed on both sides, or added twice with different text`);
    }
    tree.entries.set(id, entry);
    note(`${id}: ${original === undefined ? 'added' : 'changed'}`);
  }
  for (const [id, original] of before.entries) {
    if (theirs.entries.has(id) || !tree.entries.has(id)) continue;
    if (tree.entries.get(id)!.text !== original.text) fail(`${id}: removed here, changed there`);
    tree.entries.delete(id);
    note(`${id}: removed`);
  }
  write(tree);
};

const sameFields = (mutation: Mutation): string =>
  JSON.stringify([
    mutation.id,
    mutation.why,
    mutation.file,
    mutation.find,
    mutation.replace,
    mutation.tests,
    mutation.equivalent ?? null,
  ]);

const verify = async (ref: string): Promise<void> => {
  const failures: string[] = [];
  const text = oldSource(ref);
  const scratch = mkdtempSync(join(tmpdir(), 'split-mutations-'));
  const oldModule = join(scratch, 'old-mutations.ts');
  writeFileSync(oldModule, text);
  const before = ((await import(oldModule)) as { MUTATIONS: readonly Mutation[] }).MUTATIONS;
  rmSync(scratch, { recursive: true });
  const after = ((await import('./mutations')) as { MUTATIONS: readonly Mutation[] }).MUTATIONS;

  console.log(`base ${ref} = ${git('rev-parse', ref).trim()}`);
  console.log(
    `old file blob ${git('rev-parse', `${ref}:${OLD_PATH}`).trim()}, ${String(before.length)} entries`,
  );
  console.log(`new directory: ${String(after.length)} entries`);

  if (before.length !== after.length)
    failures.push(`length ${String(before.length)} != ${String(after.length)}`);
  const beforeIds = new Set(before.map((m) => m.id));
  const afterById = new Map(after.map((m) => [m.id, m]));
  if (beforeIds.size !== before.length) failures.push('old ids are not unique');
  if (afterById.size !== after.length) failures.push('new ids are not unique');
  for (const mutation of before) {
    const moved = afterById.get(mutation.id);
    if (moved === undefined) failures.push(`${mutation.id}: dropped`);
    else if (sameFields(mutation) !== sameFields(moved)) failures.push(`${mutation.id}: differs`);
  }
  for (const id of afterById.keys()) if (!beforeIds.has(id)) failures.push(`${id}: added`);

  const oldEntries = parse(text, OLD_PATH).entries;
  const files = readdirSync(DIRECTORY)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(DIRECTORY, name), 'utf8'));
  let verbatim = 0;
  for (const entry of oldEntries.values()) {
    const found = files.reduce((count, file) => count + file.split(entry.text).length - 1, 0);
    if (found === 1) verbatim += 1;
    else failures.push(`${entry.id}: source text occurs ${String(found)} times in the new files`);
    for (const comment of entry.comments) {
      if (!files.some((file) => file.includes(comment)))
        failures.push(`${entry.id}: lost ${comment}`);
    }
  }
  console.log(
    `compared field by field: ${String(before.length)}; source text verbatim in exactly one file: ${String(verbatim)}`,
  );

  if (failures.length > 0) {
    console.error(failures.slice(0, 50).join('\n'));
    console.error(`FAILED: ${String(failures.length)} problem(s)`);
    process.exit(1);
  }
  console.log(
    'verified: every entry is in the new files, once, with identical fields and source text',
  );
};

const args = process.argv.slice(2);
if (args[0] === '--merge') foldIn(args[1] ?? fail('--merge needs a ref'));
else if (args[0] === '--verify') await verify(args[1] ?? DEFAULT_REF);
else split(args[0] ?? DEFAULT_REF);
