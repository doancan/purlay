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

describe('the edges (D-188)', () => {
  // One grammar for a line: at rest `border-subtle` (a card, a divider) or `border-strong` (a control the
  // line is the only cue for); hover changes the *fill*, never the line; selected is `accent`, a fault is
  // `danger`. A line that darkens on hover in one place and goes blue in another is the inconsistency this
  // refuses, so the few hover edges that exist are named, and a new one has to be added here on purpose.
  const HOVER_EDGES = new Set(['hover:border-accent-hover', 'group-hover:border-nav-hover']);
  /** An edge colour that depends on hover, on a group's or a peer's hover too, whichever sides it draws. */
  const hoverEdge = (name: string): boolean => /(^|[:-])hover:border-/.test(name);
  /** An edge drawn in the ink colour, with any variant before it. */
  const inkEdge = (name: string): boolean => /(^|:)border(-[trblxy])?-ink/.test(name);
  const classes = application
    .flatMap((path) => classesIn(relative(root, path), readFileSync(path, 'utf8')))
    .map((found) => found.candidate);

  test('the classes were found at all, and so are the hover edges that are named', () => {
    expect(classes.some((name) => name === 'border-hairline')).toBe(true);
    // A filter that matches nothing proves nothing (CONTRIBUTING §6.4): each exemption is really there.
    for (const named of HOVER_EDGES) expect(classes, named).toContain(named);
  });

  test('the filters see what they are for', () => {
    for (const name of [
      'hover:border-ink-muted',
      'group-hover:border-danger',
      'peer-hover:border-accent',
      'hover:border-b-accent',
      'md:hover:border-border-strong',
    ]) {
      expect(hoverEdge(name), name).toBe(true);
    }
    for (const name of ['border-accent', 'hover:bg-surface-200', 'hover:text-ink']) {
      expect(hoverEdge(name), name).toBe(false);
    }
    for (const name of [
      'border-ink',
      'border-b-ink',
      'hover:border-ink',
      'max-narrow:border-t-ink',
    ]) {
      expect(inkEdge(name), name).toBe(true);
    }
    for (const name of ['border-border-strong', 'border-accent']) {
      expect(inkEdge(name), name).toBe(false);
    }
  });

  test('no edge changes colour on hover except the two that are named', () => {
    expect(classes.filter((name) => hoverEdge(name) && !HOVER_EDGES.has(name))).toEqual([]);
  });

  test('no edge is the ink colour: selected is the accent, not black', () => {
    expect(classes.filter(inkEdge)).toEqual([]);
  });
});

describe('the accent', () => {
  // `accent` is a fill: dark navy in both themes, so the words a dark page needs
  // are `accent-text` (D-110). A bare `text-accent` would draw navy on near-black,
  // and the way to make that impossible is for the class not to exist.
  test('is a fill, never a text colour', async () => {
    const problems = await checkVocabulary({
      entry: join(root, 'index.css'),
      resolve: resolveStylesheet,
      classes: [{ file: 'probe.tsx', line: 1, candidate: 'text-accent' }],
    });
    expect(problems).toHaveLength(1);
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
