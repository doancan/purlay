/**
 * Splits a migration file into the statements it holds.
 *
 * Needed only for a migration that opts out of its transaction (`migrator.ts`).
 * PostgreSQL runs a string holding several statements as one implicit transaction,
 * so handing such a file over whole would put back the transaction the file asked
 * to leave: `CREATE INDEX CONCURRENTLY` would be refused, and a `VALIDATE
 * CONSTRAINT` would hold the lock of the `ADD CONSTRAINT` before it.
 *
 * It understands exactly what a migration can contain that hides a semicolon: line
 * and (nested) block comments, single-quoted strings, quoted identifiers, and
 * dollar-quoted bodies. It does not understand `E'…'` escape strings, which a
 * migration has no use for, and it refuses one rather than splitting it wrongly.
 */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][\w\u0080-￿]*)?\$/;

const isEscapeString = (text: string, at: number): boolean => {
  const prefix = text[at - 1];
  if (prefix !== 'E' && prefix !== 'e') return false;
  const before = text[at - 2];
  return before === undefined || !/[\w$"]/.test(before);
};

/** True when nothing but whitespace and comments remains in the chunk. */
const isEmpty = (chunk: string): boolean =>
  chunk
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .trim() === '';

export const splitStatements = (text: string): string[] => {
  const statements: string[] = [];
  let start = 0;
  let i = 0;

  const push = (end: number): void => {
    const chunk = text.slice(start, end);
    if (!isEmpty(chunk)) statements.push(chunk.trim());
    start = end + 1;
  };

  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '-' && next === '-') {
      const eol = text.indexOf('\n', i);
      i = eol === -1 ? text.length : eol + 1;
    } else if (char === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      if (depth > 0) throw new Error('unterminated block comment in migration');
    } else if (char === "'" || char === '"') {
      if (char === "'" && isEscapeString(text, i)) {
        throw new Error('E-strings are not supported in a migration that leaves its transaction');
      }
      i += 1;
      for (;;) {
        if (i >= text.length) throw new Error(`unterminated ${char} quote in migration`);
        if (text[i] === char) {
          if (text[i + 1] === char) i += 2;
          else break;
        } else i += 1;
      }
      i += 1;
    } else if (char === '$') {
      const tag = DOLLAR_TAG.exec(text.slice(i))?.[0];
      if (tag === undefined) {
        i += 1;
      } else {
        const close = text.indexOf(tag, i + tag.length);
        if (close === -1) throw new Error(`unterminated ${tag} quote in migration`);
        i = close + tag.length;
      }
    } else if (char === ';') {
      push(i);
      i += 1;
    } else {
      i += 1;
    }
  }
  push(text.length);
  return statements;
};

/**
 * What a migration does, without what it says: every statement with its comments removed
 * and its whitespace collapsed. Two files with the same answer here run identically, which
 * is what allows the one sanctioned kind of edit to an applied migration, a corrected
 * comment (D-86). A migration with an `E'…'` string is refused, as in `splitStatements`.
 */
export const executableText = (text: string): string =>
  splitStatements(text)
    .map((statement) => {
      let code = '';
      let i = 0;
      while (i < statement.length) {
        const char = statement[i];
        const next = statement[i + 1];
        if (char === '-' && next === '-') {
          const eol = statement.indexOf('\n', i);
          i = eol === -1 ? statement.length : eol;
          code += ' ';
        } else if (char === '/' && next === '*') {
          let depth = 1;
          i += 2;
          while (i < statement.length && depth > 0) {
            if (statement[i] === '/' && statement[i + 1] === '*') {
              depth += 1;
              i += 2;
            } else if (statement[i] === '*' && statement[i + 1] === '/') {
              depth -= 1;
              i += 2;
            } else i += 1;
          }
          code += ' ';
        } else if (char === "'" || char === '"') {
          const start = i;
          i += 1;
          while (i < statement.length) {
            if (statement[i] === char) {
              if (statement[i + 1] === char) i += 2;
              else break;
            } else i += 1;
          }
          i += 1;
          code += statement.slice(start, i);
        } else if (char === '$') {
          const tag = DOLLAR_TAG.exec(statement.slice(i))?.[0];
          if (tag === undefined) {
            code += char;
            i += 1;
          } else {
            const close = statement.indexOf(tag, i + tag.length);
            const end = close === -1 ? statement.length : close + tag.length;
            code += statement.slice(i, end);
            i = end;
          }
        } else {
          code += char ?? '';
          i += 1;
        }
      }
      return code.replace(/\s+/g, ' ').trim();
    })
    .filter((statement) => statement !== '')
    .join(';\n');
