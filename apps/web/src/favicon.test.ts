/** The browser reads these pictures outside the document, so the generator writes token colours as literals. */
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
const mark = readFileSync(new URL('../scripts/purlay.svg', import.meta.url), 'utf8');
const colours = (svg: string): string[] => svg.match(/#[0-9a-f]{3,8}\b/gi) ?? [];

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
  test('draws every source path and gradient over the dark surface token', () => {
    const artwork = mark
      .trim()
      .replace(/^<svg[^>]*>\n/, '')
      .replace(/\n<\/svg>$/, '');
    expect(favicon).toContain(artwork);
    const background = dark('surface-100');
    expect(favicon).toContain(`fill="${background}"`);
    expect(new Set(colours(favicon))).toEqual(new Set([background, ...colours(mark)]));
  });

  test('is what the shell links, so no browser asks for a /favicon.ico that is not there', () => {
    expect(index).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
  });
});

const dark = (name: string): string => {
  const token = tokens.find((candidate) => candidate.name === name);
  if (token === undefined) throw new Error(`no colour token named ${name}`);
  return typeof token.value === 'string' ? token.value : (token.value['dark'] ?? '');
};

describe('the favicon while something needs the person (D-148)', () => {
  const waiting = readFileSync(new URL('../public/favicon-waiting.svg', import.meta.url), 'utf8');

  test('is the favicon, drawn the same, with a dot over it', () => {
    expect(waiting.startsWith(favicon.trim().replace(/<\/svg>$/, ''))).toBe(true);
    expect(waiting.match(/<circle /g)).toHaveLength(2);
  });

  test('uses the danger token and an on-accent ring', () => {
    const fills = [...waiting.matchAll(/<circle [^>]*fill="(#[0-9a-f]+)"/gi)].map((m) => m[1]);
    expect(fills).toEqual([single('on-accent'), dark('danger')]);
    expect(new Set(colours(waiting))).toEqual(
      new Set([...colours(favicon), single('on-accent'), dark('danger')]),
    );
  });
});
