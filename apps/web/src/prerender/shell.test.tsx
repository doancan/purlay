/**
 * The prerendered shell: what it contains, and that it is placed once or not at all.
 */
import { describe, expect, test } from 'bun:test';
import { ROOT, inject, renderShell } from './shell';

const PAGE = `<!doctype html><html><body>${ROOT}<script src="/a.js"></script></body></html>`;

describe('the shell as markup', () => {
  test('is the skeleton: sidebar, header and feed rows as layout, with no words and no script', () => {
    const markup = renderShell();
    expect(markup).toContain('w-rail');
    expect(markup).toContain('w-sidebar');
    // The first paint is the frame the page will have: flat, no canvas behind cards (D-110).
    expect(markup).not.toContain('bg-canvas');
    expect(markup).not.toContain('shadow-card');
    expect(markup).toContain('h-header');
    // Each message row keeps the avatar's column, the width the real row gives it.
    expect(markup.split('<span class="size-avatar-lg shrink-0"></span>')).toHaveLength(4);
    expect(markup).not.toContain('<script');
    // Hidden from assistive technology: a screen reader meets the real page.
    expect(markup).toContain('aria-hidden="true"');
    expect(markup.replace(/<[^>]*>/g, '').trim()).toBe('');
  });
});

describe('injecting it', () => {
  test('goes inside the root, and nowhere else', () => {
    const html = inject(PAGE, '<p>shell</p>');
    expect(html).toContain('<div id="root"><p>shell</p></div>');
    expect(html).toContain('<script src="/a.js"></script>');
    expect(html.split('<p>shell</p>')).toHaveLength(2);
  });

  test('refuses a page that has nowhere to put it, and a page that has it already', () => {
    expect(() => inject('<html></html>', 'x')).toThrow('no empty');
    const once = inject(PAGE, 'x');
    expect(() => inject(once, 'x')).toThrow('already rendered');
  });

  test('refuses a page with two roots rather than guessing', () => {
    expect(() => inject(`${ROOT}${ROOT}`, 'x')).toThrow('2 empty roots');
  });
});
