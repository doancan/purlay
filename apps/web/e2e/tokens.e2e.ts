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
    // Bob: a visit marks channels read, and the viewer's unread state is what the seeded-data spec asserts.
    await signIn('bob');
    await page.goto('/');
    // Below the breakpoint the sidebar is an overlay, so it is opened to be measured.
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    await expect(toggle.or(page.getByRole('complementary'))).toBeVisible();
    if (await toggle.isVisible()) await toggle.click();
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
    expect(values.radius).toBe('8px');
    expect(values.pill).toBe('9999px');
    expect(values.icon).toBe('12px');
    expect(values.sans).toContain('IBM Plex Sans');
    expect(values.mono).toContain('IBM Plex Mono');
  });

  test('what the screen is drawn with: the Plex faces, mono names, sized icons, rounded controls', async ({
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
    expect(drawn.body).toContain('IBM Plex Sans');
    expect(['12px', '16px', '20px']).toContain(drawn.iconWidth);
    expect(drawn.iconHeight).toBe(drawn.iconWidth);
    expect(drawn.iconStroke).toBe('2.25px');
  });

  test('the faces are really served and loaded, Turkish letters included, and from this origin', async ({
    page,
  }) => {
    const loaded = await page.evaluate(async () => {
      const sans = await document.fonts.load('400 14px "IBM Plex Sans"', 'ğşİıçöü');
      const bold = await document.fonts.load('600 14px "IBM Plex Sans"', 'Aa');
      const mono = await document.fonts.load('400 13px "IBM Plex Mono"', '0123');
      const origins = performance
        .getEntriesByType('resource')
        .filter((entry) => entry.name.endsWith('.woff2'))
        .map((entry) => new URL(entry.name).origin);
      return {
        sans: sans.length,
        bold: bold.length,
        mono: mono.length,
        origins: [...new Set(origins)],
        here: location.origin,
      };
    });
    // `load` resolves to the faces that matched; an empty list is a family that was never declared.
    expect(loaded.sans).toBeGreaterThan(0);
    expect(loaded.bold).toBeGreaterThan(0);
    expect(loaded.mono).toBeGreaterThan(0);
    expect(loaded.origins).toEqual([loaded.here]);
  });
});
