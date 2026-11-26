/**
 * The tab's icon is the one picture of the brand the page cannot paint with a token: a browser reads it
 * outside the document, where no custom property reaches. It is the owner's mark (`public/purlay-mark.svg`)
 * on a tile, and `scripts/app-icons.ts` draws it, so this holds the picture to the two things it copies:
 * the mark, exactly as the brand file draws it, and the tokens for the colours that are not the mark's
 * (CONTRIBUTING §6.1) — a changed mark or accent fails here instead of leaving the tab a different brand
 * from the product (D-339).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

interface Token {
  readonly name: string;
  readonly value: string | Readonly<Record<string, string>>;
}

const tokens = (
  JSON.parse(
    readFileSync(new URL('../../../packages/tokens/tokens.json', import.meta.url), 'utf8'),
  ) as {
    readonly color: { readonly tokens: readonly Token[] };
  }
).color.tokens;
const brand = readFileSync(new URL('../public/purlay-mark.svg', import.meta.url), 'utf8');
const favicon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8');
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** The one value a token has in every theme; a token that differs by theme has no single favicon colour. */
const single = (name: string): string => {
  const token = tokens.find((candidate) => candidate.name === name);
  if (token === undefined) throw new Error(`no colour token named ${name}`);
  const values = new Set(
    typeof token.value === 'string' ? [token.value] : Object.values(token.value),
  );
  expect(values.size).toBe(1);
  return [...values][0] ?? '';
};

/** Every colour a picture names, lower-cased. */
const coloursOf = (svg: string): Set<string> =>
  new Set((svg.match(/#[0-9a-f]{3,8}\b/gi) ?? []).map((colour) => colour.toLowerCase()));

/** The colours the brand file's gradients are made of: the owner's, bound to no token. */
const markColours = coloursOf(brand);

describe('the favicon', () => {
  test('draws every path of the brand file, each filled by its own gradient', () => {
    const paths = [...brand.matchAll(/<path\b[^>]*\sd="([^"]+)"/g)].map((match) => match[1] ?? '');
    expect(paths.length).toBeGreaterThan(0);
    for (const d of paths) expect(favicon).toContain(`d="${d}"`);
    expect(favicon.match(/<path /g)).toHaveLength(paths.length);
  });

  test('stands on a tile that is the on-accent token, in every theme', () => {
    expect(favicon).toContain(
      `<rect width="1024" height="1024" rx="224" fill="${single('on-accent')}"/>`,
    );
  });

  test("holds no colour that is not the tile's or the mark's", () => {
    expect(coloursOf(favicon)).toEqual(new Set([single('on-accent'), ...markColours]));
  });

  test('stays small, because it comes with every page', () => {
    expect(Buffer.byteLength(favicon)).toBeLessThanOrEqual(2048);
  });

  test('is what the shell links, so no browser asks for a /favicon.ico that is not there', () => {
    expect(index).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
  });
});

/** Every value a token has, in any theme. */
const anyOf = (name: string): string[] => {
  const token = tokens.find((candidate) => candidate.name === name);
  if (token === undefined) throw new Error(`no colour token named ${name}`);
  return typeof token.value === 'string' ? [token.value] : Object.values(token.value);
};

describe('the favicon while something needs the person (D-148)', () => {
  const waiting = readFileSync(new URL('../public/favicon-waiting.svg', import.meta.url), 'utf8');

  test('is the favicon, drawn the same, with a dot over it', () => {
    expect(waiting.startsWith(favicon.trim().replace(/<\/svg>$/, ''))).toBe(true);
    expect(waiting.match(/<circle /g)).toHaveLength(2);
  });

  test('the dot is danger, ringed in the tile so that it stands off the mark', () => {
    const fills = [...waiting.matchAll(/<circle [^>]*fill="(#[0-9a-f]+)"/gi)].map((m) => m[1]);
    expect(fills[0]).toBe(single('on-accent'));
    expect(anyOf('danger')).toContain(fills[1] ?? '');
  });

  test("holds no colour that is not the tile's, the mark's or danger's", () => {
    const allowed = new Set([single('on-accent'), ...markColours, ...anyOf('danger')]);
    for (const colour of coloursOf(waiting)) expect(allowed).toContain(colour);
  });
});
