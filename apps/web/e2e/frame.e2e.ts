/**
 * The frame every screen sits in: the skip link, focus that follows a navigation, a page
 * that is not found, the gallery in both themes, theme and language that stick and never
 * flash. What the people who use a keyboard and a screen reader get from a single-page
 * application the browser no longer provides on its own.
 */
import { expect, focused, tabTo, test } from './fixtures';

test.describe('the keyboard', () => {
  test('the first Tab finds the skip link, and following it moves focus to main', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.keyboard.press('Tab');
    expect(await focused(page)).toContain('Skip to the conversation');
    await page.keyboard.press('Enter');
    await expect(page.locator('#main')).toBeFocused();
  });

  test('every control on the sign-in screen is reachable by Tab, in a handful of presses', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const presses = await tabTo(page, page.getByRole('link', { name: 'Continue with GitHub' }));
    expect(presses).toBeLessThanOrEqual(3);
  });

  test('a navigation moves focus to the new page, not to where the old link was', async ({
    page,
  }) => {
    await page.goto('/nowhere');
    await page.getByRole('link', { name: 'Go to your channels' }).click();
    // `/` asks who is signed in, finds nobody, and goes to sign-in: three steps, one focus.
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Purlay' })).toBeVisible();
    await expect(page.locator('#main')).toBeFocused();
  });
});

test.describe('an address that leads nowhere', () => {
  test('says so, offers the way home, and is clean and unchanged', async ({
    page,
    expectNoAxe,
  }) => {
    await page.goto('/nowhere');
    await expect(page.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();
    await expectNoAxe();
    await expect(page).toHaveScreenshot('not-found.png');
  });
});

test.describe('the gallery', () => {
  test('shows every primitive in both themes at once, and is clean in this one', async ({
    page,
    expectNoAxe,
  }) => {
    await page.goto('/__gallery');
    await expect(page.getByRole('heading', { level: 1, name: 'Gallery' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Dark' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'Light' })).toBeVisible();
    await expectNoAxe();
    await expect(page).toHaveScreenshot('gallery.png', { fullPage: true });
  });
});

test.describe('the theme', () => {
  const expected = (project: string): 'dark' | 'light' =>
    project.includes('light') ? 'light' : 'dark';

  test("is the operating system's until chosen, and is set before the first paint — no flash", async ({
    page,
  }, info) => {
    await page.addInitScript(() => {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-paint') {
            (window as unknown as Record<string, string>)['__themeAtFirstPaint'] =
              document.documentElement.getAttribute('data-theme') ?? 'none';
          }
        }
      }).observe({ type: 'paint', buffered: true });
    });
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const atPaint = await page.evaluate(
      () => (window as unknown as Record<string, string>)['__themeAtFirstPaint'],
    );
    expect(atPaint).toBe(expected(info.project.name));
  });

  test('a choice is kept across a reload and wins over the operating system', async ({
    page,
  }, info) => {
    const other = expected(info.project.name) === 'dark' ? 'light' : 'dark';
    await page.goto('/__gallery');
    await page.getByRole('button', { name: 'Theme' }).click();
    await page.getByRole('menuitemradio', { name: other === 'dark' ? 'Dark' : 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', other);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', other);
    expect(await page.evaluate(() => localStorage.getItem('purlay.theme'))).toBe(other);
  });
});

test.describe('the language', () => {
  test('switches to Turkish, says so in the document, and keeps it across a reload', async ({
    page,
  }) => {
    await page.goto('/__gallery');
    await page.getByRole('button', { name: 'Language' }).click();
    await page.getByRole('menuitemradio', { name: 'Türkçe' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Sign in to Purlay');
  });
});
