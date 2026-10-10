/**
 * The interface speaks the token vocabulary, and only that.
 *
 * Three claims, each checked against the real application rather than a sample:
 *
 * 1. every class the code writes down exists in the vocabulary and builds to a
 *    token, not to a raw value — so a typo, a palette colour and a bare `z-50`
 *    fail here, not in a user's browser;
 * 2. the one stylesheet holds no literal colour, length or duration — it reads
 *    tokens like everything else;
 * 3. the page starts in the theme the tokens call the default.
 *
 * What lint cannot see (a class that Tailwind builds from a bare number) and what
 * the type checker cannot see (a class that is a typo) are exactly what 1 is for.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defaultTheme } from '@purlay/tokens';
import {
  checkVocabulary,
  classesIn,
  rawValueIn,
  resolveStylesheet,
} from '@purlay/tokens/vocabulary';

const root = new URL('.', import.meta.url).pathname;
const files = (extension: RegExp): readonly string[] =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && extension.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));

/** Source the user can see: not tests, and not the test harness. */
const application = files(/\.tsx?$/).filter(
  (path) => !/\.test\.tsx?$/.test(path) && !relative(root, path).startsWith('testing/'),
);

describe('the application’s classes', () => {
  test('are all in the token vocabulary, and none builds to a raw value', async () => {
    const classes = application.flatMap((path) =>
      classesIn(relative(root, path), readFileSync(path, 'utf8')),
    );
    // A check that found nothing proves nothing (CONTRIBUTING §6.4): the shell
    // alone writes down classes, so an empty list means the extraction broke.
    expect(classes.length).toBeGreaterThan(0);
    const problems = await checkVocabulary({
      entry: join(root, 'index.css'),
      resolve: resolveStylesheet,
      classes,
    });
    expect(problems).toEqual([]);
  });
});

describe('the stylesheet', () => {
  // Comments explain the rules; they are not rules, and quote what they forbid.
  const css = readFileSync(join(root, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  test('is the only one, so there is one place to look', () => {
    expect(files(/\.css$/).map((path) => relative(root, path))).toEqual(['index.css']);
  });

  test('imports Tailwind in pieces, never its default theme', () => {
    const imports = [...css.matchAll(/@import\s+'([^']+)'/g)].map((match) => match[1]);
    expect(imports).toEqual([
      'tailwindcss/preflight.css',
      '@purlay/tokens/tokens.css',
      '@purlay/tokens/theme.css',
      'tailwindcss/utilities.css',
    ]);
    expect(css).not.toMatch(/@import\s+['"]tailwindcss['"]/);
    expect(css).not.toContain('tailwindcss/theme');
  });

  test('holds no literal colour, length or duration', () => {
    const declarations = [...css.matchAll(/^\s*([a-z-]+)\s*:\s*([^;{}]+);/gm)];
    expect(declarations.length).toBeGreaterThan(0);
    for (const [, property = '', value = ''] of declarations) {
      expect([property, rawValueIn(property, value.trim())]).toEqual([property, undefined]);
    }
  });
});

describe('the page', () => {
  test('starts in the theme the tokens call the default', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toContain(`data-theme="${defaultTheme}"`);
  });
});
