/**
 * The tables a module's source names where the compiler cannot see them (D-271, `MODULES.md` §4): the text of a raw `sql`
 * template, a column written `table.column`, a table given to `tableExists`, an index into the schema type. The typed
 * handle (`ModuleSchema`) refuses a foreign table in the builder; this reads what is left, and the builder's own first
 * arguments too, so that a module not yet behind the handle is held to the same list.
 *
 * It looks for a table in the places a statement puts one, not for every word: `messages` is a field in plenty of code.
 * Comments are blanked first, keeping the lines, so a finding is `file:line`. A table name built at run time is not seen.
 */

/** What a source does to a table it names. A statement's `select ... for update` is a read. */
export interface TableUse {
  readonly table: string;
  readonly line: number;
  readonly write: boolean;
}

const WRITING_BUILDER_METHODS = 'insertInto|deleteFrom|updateTable|mergeInto';
const READING_BUILDER_METHODS =
  'selectFrom|with|innerJoin|leftJoin|rightJoin|fullJoin|crossJoin|innerJoinLateral|leftJoinLateral|crossJoinLateral';
const WRITING_SQL = String.raw`(?:insert\s+into|delete\s+from|update|merge\s+into|truncate(?:\s+table)?)`;
const READING_SQL = String.raw`(?:(?<!delete\s+)from|join)`;

/** A comment's characters are spaces and its newlines stay: the lines of what is left are the file's. */
const withoutComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/.*$/gm, (comment) => ' '.repeat(comment.length));

/**
 * The text of each template literal tagged `sql` or `sql<T>`, with the line it starts on. A template is read to its
 * closing backtick through `${…}`, which may hold templates of its own.
 */
const sqlTemplates = (
  code: string,
): readonly { readonly text: string; readonly line: number }[] => {
  const found: { text: string; line: number }[] = [];
  const skipTemplate = (from: number): number => {
    let index = from;
    while (index < code.length) {
      const char = code[index];
      if (char === '\\') index += 2;
      else if (char === '`') return index + 1;
      else if (char === '$' && code[index + 1] === '{') index = skipExpression(index + 2);
      else index += 1;
    }
    return code.length;
  };
  const skipExpression = (from: number): number => {
    let depth = 1;
    let index = from;
    while (index < code.length && depth > 0) {
      const char = code[index];
      if (char === '`') index = skipTemplate(index + 1);
      else {
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        index += 1;
      }
    }
    return index;
  };
  for (const tag of code.matchAll(/\bsql(?:<[^`]*?>)?`/g)) {
    const start = tag.index + tag[0].length;
    const end = skipTemplate(start);
    found.push({
      text: code.slice(start, end - 1),
      line: code.slice(0, start).split('\n').length,
    });
  }
  return found;
};

const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length;

/** Every use of a table of `tables` that `source` makes in a place a statement names one. */
export const tablesNamed = (source: string, tables: readonly string[]): readonly TableUse[] => {
  if (tables.length === 0) return [];
  const names = `(?:${[...tables].sort((a, b) => b.length - a.length).join('|')})`;
  const code = withoutComments(source);
  const uses: TableUse[] = [];
  const collect = (
    text: string,
    pattern: RegExp,
    write: boolean,
    firstLine: number,
    nameGroup = 1,
  ): void => {
    for (const found of text.matchAll(pattern)) {
      const table = found[nameGroup];
      if (table === undefined) continue;
      const use = { table, line: firstLine + lineOf(text, found.index) - 1, write };
      if (
        !uses.some(
          (seen) => seen.table === use.table && seen.line === use.line && seen.write === use.write,
        )
      )
        uses.push(use);
    }
  };

  const builder = (methods: string): RegExp =>
    new RegExp(String.raw`\.(?:${methods})\(\s*['"\`](${names})\b`, 'g');
  collect(code, builder(WRITING_BUILDER_METHODS), true, 1);
  collect(code, builder(READING_BUILDER_METHODS), false, 1);
  collect(
    code,
    new RegExp(String.raw`['"\`](${names})(?:\.[a-z_*]+|\s+as\s+\w+)['"\`]`, 'g'),
    false,
    1,
  );
  collect(
    code,
    new RegExp(String.raw`\btableExists\(\s*[^,()]+,\s*['"](${names})['"]`, 'g'),
    false,
    1,
  );
  collect(
    code,
    new RegExp(String.raw`\b(?:Database|DB)\[\s*['"](${names})['"]\s*\]`, 'g'),
    false,
    1,
  );
  for (const template of sqlTemplates(code)) {
    const word = String.raw`\s+(?:only\s+)?(?:public\.)?(${names})\b`;
    collect(
      template.text,
      new RegExp(String.raw`\b${WRITING_SQL}${word}`, 'gi'),
      true,
      template.line,
    );
    collect(
      template.text,
      new RegExp(String.raw`\b${READING_SQL}${word}`, 'gi'),
      false,
      template.line,
    );
  }
  return uses.sort((a, b) => a.line - b.line || a.table.localeCompare(b.table));
};

/** The uses in `source` of a table of `tables` that `allowed` does not hold: a table that is neither the module's nor one it reads. */
export const foreignUses = (
  source: string,
  tables: readonly string[],
  allowed: readonly string[],
): readonly TableUse[] => tablesNamed(source, tables).filter((use) => !allowed.includes(use.table));

/** The writes in `source` of a table of `coreTables`. */
export const coreWrites = (source: string, coreTables: readonly string[]): readonly TableUse[] =>
  tablesNamed(source, coreTables).filter((use) => use.write);

/** The writes of a core table that `said` does not account for: the ones nobody wrote a reason beside. */
export const unsaidCoreWrites = (
  source: string,
  coreTables: readonly string[],
  said: (table: string) => boolean,
): readonly TableUse[] => coreWrites(source, coreTables).filter((use) => !said(use.table));
