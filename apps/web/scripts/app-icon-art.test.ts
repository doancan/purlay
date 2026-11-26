/**
 * The pictures are exactly what the owner's mark makes (D-339): what is committed in `public/` is what
 * `app-icon-art.ts` draws from `public/purlay-mark.svg`, so a hand edit of a picture, or a new mark that
 * was not drawn again with `bun run icons`, fails here. The brand file ships on every page load, so it may
 * carry nothing that acts, and a file that does is refused.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { favicon, fullBleed, readMark, waitingFavicon } from './app-icon-art';

const publicFile = (name: string): string =>
  readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const brand = publicFile('purlay-mark.svg');
const mark = readMark(brand);

describe('the brand file', () => {
  test('carries only gradients and paths, so nothing in it can act', () => {
    expect(() => readMark(brand)).not.toThrow();
    expect(brand).not.toMatch(/<script|<style|<image|<foreignObject|\son\w+=|href=/i);
  });

  test('is refused when it carries something active, rather than cleaned', () => {
    expect(() => readMark(brand.replace('<g>', '<g onload="x()">'))).toThrow();
    expect(() => readMark(brand.replace('<g>', '<script>x()</script><g>'))).toThrow();
    expect(() => readMark(brand.replace('url(#stem)', 'url(https://example.com/x)'))).toThrow();
  });

  test('is refused when it is not the shape the pictures are drawn from', () => {
    expect(() => readMark('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toThrow();
  });
});

describe('the pictures committed in public/', () => {
  test('favicon.svg is the mark on its tile, exactly as it is drawn', () => {
    expect(publicFile('favicon.svg')).toBe(favicon(mark));
  });

  test('favicon-waiting.svg is the favicon with the dot over it, exactly as it is drawn', () => {
    expect(publicFile('favicon-waiting.svg')).toBe(waitingFavicon(mark));
  });

  test('the full-bleed picture is the favicon without its rounding and nothing else', () => {
    const rounded = favicon(mark);
    expect(rounded).toContain(' rx="224"');
    expect(fullBleed(rounded)).toBe(rounded.replace(' rx="224"', ''));
  });
});
