/**
 * The favicon is the one picture of the brand the page cannot paint with a token: a browser
 * reads it outside the document, where no custom property reaches. So it carries the colours
 * as literals, and this binds each to the token it copies (CONTRIBUTING §6.1) — a changed
 * accent fails here instead of leaving the tab a different blue from the product.
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

describe('the favicon', () => {
  test('is filled with the accent and drawn in on-accent', () => {
    expect(favicon).toContain(`fill="${single('accent')}"`);
    expect(favicon).toContain(`stroke="${single('on-accent')}"`);
  });

  test('holds no colour that is not one of those two', () => {
    const colours = new Set(favicon.match(/#[0-9a-f]{3,8}\b/gi) ?? []);
    expect(colours).toEqual(new Set([single('accent'), single('on-accent')]));
  });

  test('is what the shell links, so no browser asks for a /favicon.ico that is not there', () => {
    expect(index).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
  });
});
