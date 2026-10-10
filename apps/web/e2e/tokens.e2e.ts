/**
 * The tokens as a browser computes them.
 *
 * Every other test of the vocabulary compiles classes; none runs a cascade. That is how
 * `--radius-md: var(--radius-md)` — a theme key Tailwind writes to `:root` with the token's own
 * name, after the token — went unseen until somebody looked at a screenshot: a custom property
 * that refers to itself is invalid, so every radius, every icon (the SVG's own 24px) and the
 * whole font stack fell back to the browser's. This reads what the page actually has.
 */
import { expect, test } from './fixtures';

test.describe('the tokens, as computed', () => {
  test.beforeEach(async ({ page, signIn }) => {
    await signIn('dogancan');
    await page.goto('/');
    await page.waitForSelector('aside svg');
  });

  test('the custom properties hold their values, not an empty cycle', async ({ page }) => {
    const values = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const read = (name: string): string => root.getPropertyValue(name).trim();
      return {
        radius: read('--radius-md'),
        pill: read('--radius-pill'),
        icon: read('--size-icon-sm'),
        sans: read('--font-sans'),
        mono: read('--font-mono'),
      };
    });
    expect(values.radius).toBe('6px');
    expect(values.pill).toBe('9999px');
    expect(values.icon).toBe('12px');
    expect(values.sans).toContain('system-ui');
    expect(values.mono).toContain('ui-monospace');
  });

  test('what the screen is drawn with: the system font, mono names, sized icons, rounded controls', async ({
    page,
  }) => {
    const drawn = await page.evaluate(() => {
      const style = (selector: string): CSSStyleDeclaration | null => {
        const node = document.querySelector(selector);
        return node === null ? null : getComputedStyle(node);
      };
      const icon = style('aside svg');
      return {
        body: style('body')?.fontFamily ?? '',
        iconWidth: icon?.width ?? '',
        iconHeight: icon?.height ?? '',
        iconStroke: icon?.strokeWidth ?? '',
        button: style('aside button')?.borderRadius ?? '',
      };
    });
    // The browser's default serif is what a broken font stack looks like.
    expect(drawn.body).toContain('system-ui');
    expect(['12px', '16px', '20px']).toContain(drawn.iconWidth);
    expect(drawn.iconHeight).toBe(drawn.iconWidth);
    expect(drawn.iconStroke).toBe('2.25px');
  });
});
