import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { executableText, splitStatements } from './statements';

describe('splitStatements', () => {
  test('splits on semicolons and drops chunks that are only comments', () => {
    const text =
      '-- header; with a semicolon\nCREATE TABLE a (id int);\n\n/* x; y */\nDROP TABLE a;\n-- tail';
    expect(splitStatements(text)).toEqual([
      '-- header; with a semicolon\nCREATE TABLE a (id int)',
      '/* x; y */\nDROP TABLE a',
    ]);
  });

  test('does not split inside strings, quoted identifiers or dollar-quoted bodies', () => {
    const text = [
      "INSERT INTO t VALUES ('a;b', 'it''s; fine');",
      'ALTER TABLE "we;ird" ADD COLUMN "q""x;" int;',
      'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $body$ SELECT 1; SELECT 2; $body$;',
      'SELECT $$a;b$$;',
    ].join('\n');
    expect(splitStatements(text)).toHaveLength(4);
  });

  test('block comments nest', () => {
    expect(splitStatements('/* a /* b; */ c; */ SELECT 1;')).toEqual([
      '/* a /* b; */ c; */ SELECT 1',
    ]);
  });

  test('keeps a final statement without a trailing semicolon', () => {
    expect(splitStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  test('refuses what it cannot split rather than splitting it wrongly', () => {
    expect(() => splitStatements("SELECT 'open;")).toThrow('unterminated');
    expect(() => splitStatements('SELECT $a$ open;')).toThrow('unterminated');
    expect(() => splitStatements('/* open; SELECT 1;')).toThrow('unterminated');
    expect(() => splitStatements("SELECT E'a\\'b;';")).toThrow('E-strings');
  });

  test('every migration in the repository splits, and loses no CREATE TABLE', () => {
    // The real files are the realistic input: a missing statement would mean the
    // splitter swallowed part of a migration into a comment or a string.
    for (const file of readdirSync('packages/db/migrations').filter((f) => f.endsWith('.sql'))) {
      const text = readFileSync(`packages/db/migrations/${file}`, 'utf8');
      const statements = splitStatements(text);
      expect(statements.length).toBeGreaterThan(0);
      const code = text.replace(/--[^\n]*/g, '');
      const expected = (code.match(/^CREATE TABLE/gm) ?? []).length;
      expect(statements.filter((s) => /^(--[^\n]*\n|\s)*CREATE TABLE/.test(s))).toHaveLength(
        expected,
      );
    }
  });
});

describe('executableText', () => {
  test('is the same for two files that differ only in their comments and layout', () => {
    const before = "-- a\nALTER TABLE t  ADD x int; /* why */\nSELECT 'a -- b; c';";
    const after =
      "-- a different comment\n\nALTER TABLE t\n    ADD x int;\nSELECT 'a -- b; c'; -- trailing";
    expect(executableText(after)).toBe(executableText(before));
    expect(executableText(before)).toBe("ALTER TABLE t ADD x int;\nSELECT 'a -- b; c'");
  });

  test('differs when a statement, a string, or a quoted identifier does', () => {
    const base = executableText('SELECT \'a\', "b";');
    expect(executableText('SELECT \'a2\', "b";')).not.toBe(base);
    expect(executableText('SELECT \'a\', "b2";')).not.toBe(base);
    expect(executableText('SELECT \'a\', "b"; SELECT 1;')).not.toBe(base);
  });

  test('removes a nested block comment whole, and keeps a lone dollar sign', () => {
    expect(executableText('SELECT /* a /* b */ still a comment */ $1, 2;')).toBe('SELECT $1, 2');
  });

  test('keeps a comment marker inside a dollar-quoted body', () => {
    expect(executableText('SELECT $b$ -- not a comment; $b$;')).toBe(
      'SELECT $b$ -- not a comment; $b$',
    );
  });
});
