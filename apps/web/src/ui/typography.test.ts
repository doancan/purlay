/**
 * A text style, and a family or weight utility beside it, must resolve the way
 * the markup reads.
 *
 * `text-body font-mono` means "body size, in the mono face" — the sidebar's channel
 * names are exactly that — and `text-body font-semibold` means "bold, when unread".
 * Both only work if Tailwind emits `font-mono` and `font-semibold` **after** the
 * `text-*` styles, because both set a property the style also sets and the later
 * rule wins. Tailwind decides that order, not us, and the vocabulary check builds
 * each class alone, so it cannot see a conflict. This does: it builds them
 * together, in the real stylesheet, and fails if the order ever flips (a Tailwind
 * upgrade is the likely cause).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { compile } from 'tailwindcss';
import { resolveStylesheet } from '@purlay/tokens/vocabulary';

const entry = new URL('../index.css', import.meta.url).pathname;

const built = async (classes: readonly string[]): Promise<string> => {
  const compiler = await compile(readFileSync(entry, 'utf8'), {
    base: entry.slice(0, entry.lastIndexOf('/')),
    loadStylesheet: (id) => {
      const path = resolveStylesheet(id);
      return Promise.resolve({
        path,
        base: path.slice(0, path.lastIndexOf('/')),
        content: readFileSync(path, 'utf8'),
      });
    },
  });
  return compiler.build([...classes]);
};

describe('what comes later wins', () => {
  test('a family utility overrides the family of a text style', async () => {
    const css = await built(['text-body', 'font-mono']);
    expect(css.indexOf('.font-mono')).toBeGreaterThan(css.indexOf('.text-body'));
  });

  test('a weight utility overrides the weight of a text style', async () => {
    const css = await built(['text-body', 'font-semibold', 'font-medium']);
    expect(css.indexOf('.font-semibold')).toBeGreaterThan(css.indexOf('.text-body'));
    expect(css.indexOf('.font-medium')).toBeGreaterThan(css.indexOf('.text-body'));
  });

  test('and that holds for every text style, not only body', async () => {
    const styles = [
      'text-display',
      'text-title',
      'text-heading',
      'text-label',
      'text-caption',
      'text-code',
    ];
    const css = await built([...styles, 'font-mono', 'font-semibold']);
    for (const style of styles) {
      expect(css.indexOf('.font-mono')).toBeGreaterThan(css.indexOf(`.${style}`));
      expect(css.indexOf('.font-semibold')).toBeGreaterThan(css.indexOf(`.${style}`));
    }
  });
});
