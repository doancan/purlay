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
  test('the avatar is one column and the text is one column: rows, the day chip, threads, the composer card', async ({
    page,
    signIn,
    world,
  }) => {
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('article').first()).toBeVisible();

    // Rows: the avatar column, then the body — each at one x, however many messages there are.
    const gutters = await lefts(page, 'article > div:first-child');
    const bodies = await lefts(page, 'article > div:nth-child(2)');
    expect(gutters).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    const [gutter] = gutters;
    const [body] = bodies;
    if (gutter === undefined || body === undefined) throw new Error('no message rows on screen');
    expect(body - gutter).toBe(40); // the 28px avatar + a 12px gap

    // The composer is a card whose edge is the rows' edge, so the column reads as one.
    const cards = await lefts(page, '[data-composer-card]');
    const rows = await lefts(page, 'article');
    expect(cards).toHaveLength(1);
    expect(rows).toContain(cards[0]);
    // The day is a chip in the middle of the column, not a rule hung from its edge.
    const chip = page.getByText('Yesterday', { exact: true }).first();
    if ((await chip.count()) > 0) {
      const box = await chip.boundingBox();
      const column = await page.locator('[role="feed"]').boundingBox();
      expect(
        Math.abs(
          (box?.x ?? 0) + (box?.width ?? 0) / 2 - ((column?.x ?? 0) + (column?.width ?? 0) / 2),
        ),
      ).toBeLessThanOrEqual(2);
    }
    const status = page.getByRole('button', { name: /^(Open ·|Resolved by)/ }).first();
    if ((await status.count()) > 0) {
      expect(Math.round((await status.boundingBox())?.x ?? -1), 'a thread status line').toBe(body);
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
    await page.getByRole('button', { name: 'Theme' }).click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expectNoAxe(menu);
  });
});
