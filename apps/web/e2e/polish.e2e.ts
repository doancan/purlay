/**
 * What the eye checks and a unit test cannot: that the columns of a channel are one column,
 * that the palette opens where the prototype opens it, and that every screen is readable in
 * both themes — contrast measured by axe on the real pixels, which catches the usage the
 * token gate's table never sees (a muted ink on a tinted row, opacity, a hover state).
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const channelPath = (slug: string, id: string): string => `/w/${slug}/c/${id}`;

/** The left edge of everything that matches, rounded, without repeats. */
const lefts = async (page: Page, selector: string): Promise<number[]> =>
  await page.evaluate(
    (css) => [
      ...new Set(
        [...document.querySelectorAll(css)]
          .filter((node) => node.getBoundingClientRect().width > 0)
          .map((node) => Math.round(node.getBoundingClientRect().left)),
      ),
    ],
    selector,
  );

test.describe('the columns of a channel', () => {
  test('two edges, each one line: the avatars, the bubbles on the left, the bubbles on the right, the composer under them', async ({
    page,
    signIn,
    world,
  }) => {
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('article').first()).toBeVisible();

    // Everyone else's rows: the avatar column, then the bubble — each at one x (D-119).
    const gutters = await lefts(page, 'article:not([data-outgoing]) > div:first-child');
    const bubbles = await lefts(
      page,
      'article:not([data-outgoing]) > div:nth-child(2) [data-bubble]',
    );
    expect(gutters).toHaveLength(1);
    expect(bubbles).toHaveLength(1);
    const [gutter] = gutters;
    const [bubble] = bubbles;
    if (gutter === undefined || bubble === undefined) throw new Error('no message rows on screen');
    expect(bubble - gutter).toBe(48); // the 36px avatar + a 12px gap

    // The person's own bubbles end on one right edge, the rows' right edge less their padding.
    const rights = await page.evaluate(() => [
      ...new Set(
        [...document.querySelectorAll('article[data-outgoing] > div > div > [data-bubble]')]
          .filter((node) => node.closest('article')?.parentElement?.getAttribute('role') === 'feed')
          .map((node) => Math.round(node.getBoundingClientRect().right)),
      ),
    ]);
    expect(rights.length).toBeLessThanOrEqual(1);

    // The composer card is under the rows: the feed and the composer are one centred column.
    const cards = await lefts(page, '[data-composer-card]');
    const rows = await lefts(page, '[role="feed"] > article');
    expect(cards).toHaveLength(1);
    expect(rows).toContain(cards[0]);
    // A thread's status line under somebody else's message starts where their bubble does.
    const status = page
      .locator('article:not([data-outgoing])')
      .getByRole('button', { name: /^(Open ·|Resolved by)/ })
      .first();
    if ((await status.count()) > 0) {
      expect(Math.round((await status.boundingBox())?.x ?? -1), 'a thread status line').toBe(
        bubble,
      );
    }
  });
});

test.describe('the command palette', () => {
  test('opens in the upper part of the window, where the prototype puts it, not against the top edge', async ({
    page,
    signIn,
    world,
  }) => {
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: 'Command palette' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    expect(box?.y ?? 0).toBeGreaterThan(96);
    expect(box?.y ?? Infinity).toBeLessThan(height / 3);
    // Centred, whatever the width.
    const width = page.viewportSize()?.width ?? 0;
    expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - width / 2)).toBeLessThanOrEqual(1);
  });

  // The one opening the product animates (D-110): 150ms from 0.98 with a fade — and none at all
  // for somebody who asked their system for less motion.
  for (const [motion, expected] of [
    ['no-preference', '0.15s'],
    ['reduce', '0s'],
  ] as const) {
    test(`opens in ${expected} when the system's motion preference is ${motion}`, async ({
      page,
      signIn,
      world,
    }) => {
      await page.emulateMedia({ reducedMotion: motion });
      await signIn('bob');
      await page.goto(channelPath(world.workspace.slug, world.channels.api));
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.keyboard.press('ControlOrMeta+k');
      const dialog = page.getByRole('dialog', { name: 'Command palette' });
      await expect(dialog).toBeVisible();
      const animation = await dialog.evaluate((node) => {
        const style = getComputedStyle(node);
        return { name: style.animationName, duration: style.animationDuration };
      });
      expect(animation.name).not.toBe('none');
      expect(animation.duration).toBe(expected);
    });
  }
});

test.describe('readable, in whichever theme this project is', () => {
  const screens = (slug: string, channels: Record<string, string>): [string, string][] => [
    [
      'a channel with code, mentions, reactions and threads',
      channelPath(slug, channels['api'] ?? ''),
    ],
    ['a long channel', channelPath(slug, channels['deploys'] ?? '')],
    ['an empty channel', channelPath(slug, channels['design'] ?? '')],
    ['the open questions', `/w/${slug}/questions`],
  ];

  test('every screen has no contrast, label or role violation', async ({
    page,
    signIn,
    world,
    expectNoAxe,
  }) => {
    await signIn('bob');
    for (const [name, path] of screens(world.workspace.slug, world.channels)) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      try {
        await expectNoAxe();
      } catch (error) {
        throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    }
  });

  test('so is every overlay that opens over them: the palette, a new channel, a menu', async ({
    page,
    signIn,
    world,
    expectNoAxe,
  }) => {
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expectNoAxe(palette);
    await page.keyboard.press('Escape');

    // On a narrow window the sidebar is behind its toggle.
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    const reachSidebar = async (): Promise<void> => {
      if (await toggle.isVisible()) await toggle.click();
    };
    await reachSidebar();
    await page.getByRole('button', { name: 'New channel' }).click();
    const create = page.getByRole('dialog', { name: 'New channel' });
    await expect(create).toBeVisible();
    await expectNoAxe(create);
    await page.keyboard.press('Escape');

    await reachSidebar();
    await page.getByRole('button', { name: /^Account: / }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expectNoAxe(menu);
  });
});

test.describe("a message's hover controls (#653)", () => {
  test('clear the first line of their message, and on a wide window the row above it too', async ({
    page,
    signIn,
    world,
  }) => {
    await signIn('bob');
    await page.goto(`/w/${world.workspace.slug}/c/${world.channels.api}`);
    const rows = page.locator('[data-message-row]');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    const measured: string[] = [];
    const wide = (page.viewportSize()?.width ?? 0) >= 900;
    for (let i = Math.max(1, count - 8); i < count; i += 1) {
      const row = rows.nth(i);
      await row.scrollIntoViewIfNeeded();
      await row.hover();
      const controls = row.locator('[data-hover-controls]').first();
      if ((await controls.count()) === 0) continue;
      await expect(controls).toHaveCSS('opacity', '1');
      const overlap = await row.evaluate((element) => {
        const bar = element.querySelector('[data-hover-controls]')?.getBoundingClientRect();
        const text = element.querySelector('p, pre')?.firstChild;
        if (bar === undefined || text === null || text === undefined) return null;
        const range = document.createRange();
        range.selectNodeContents(text);
        const line = range.getClientRects()[0];
        const above = element.previousElementSibling?.getBoundingClientRect();
        return {
          intoTheLine: line === undefined ? 0 : bar.bottom - line.top,
          intoTheRowAbove: above === undefined ? 0 : above.bottom - bar.top,
        };
      });
      if (overlap === null) continue;
      measured.push(JSON.stringify(overlap));
      expect(
        overlap.intoTheLine,
        `the controls are over the first line of row ${String(i)}`,
      ).toBeLessThanOrEqual(0);
      // A narrow window's controls are a finger tall (size-touch) and taller than the gap between rows:
      // there they hang over the corner of the row above rather than over their own words, as a chat's
      // hover controls commonly do. A wide window has room for both.
      if (wide) {
        expect(
          overlap.intoTheRowAbove,
          `the controls are over the row above row ${String(i)}`,
        ).toBeLessThanOrEqual(0);
      }
    }
    expect(measured.length, 'no row was measured').toBeGreaterThan(3);
  });

  test('are not drawn while the message is being edited', async ({ page, signIn, room }) => {
    // Seeded before the page loads, as editing.e2e.ts does: sent from the page and edited at once,
    // the row being edited could be the optimistic one the server's echo was replacing.
    const made = await room({ messages: [{ by: 'dogancan', text: 'a message to edit' }] });
    await signIn();
    await page.goto(made.path);
    const row = page.locator('[data-message-row]', { hasText: 'a message to edit' });
    await expect(row).toBeVisible();
    await page.getByRole('textbox', { name: /^Message/ }).focus();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('textbox', { name: 'Edit your message' })).toBeFocused();
    await row.hover();
    await expect(row.locator('[data-hover-controls]')).toHaveCount(0);
  });
});
