/**
 * The narrow window (`UX.md` §2): the sidebar is an overlay, nothing runs off the side of the
 * page, and a finger can hit what it is meant to — measured in a browser, because none of it
 * is a property a component test can see.
 *
 * 390 × 844 is a phone held upright. The project's own viewport is irrelevant to these (each
 * `describe` sets its own), but the colour scheme is: every assertion runs in both themes.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

/** The route of a screen, so a spec says what it means and not where it is. */
const channelPath = (slug: string, id: string): string => `/w/${slug}/c/${id}`;

/**
 * How far the widest thing runs past its box: the document, and every region that scrolls on its own.
 * The feed is one such region, so a row too wide for it scrolls the feed sideways while the document
 * stays exactly the window's width — measuring the document alone passed with a thread's actions off
 * the edge. A code block and a diff are the things meant to scroll sideways, so they and what is inside
 * them are not counted.
 */
const horizontalOverflow = async (page: Page): Promise<number> =>
  await page.evaluate(() => {
    let widest = document.documentElement.scrollWidth - window.innerWidth;
    for (const element of document.body.querySelectorAll('*')) {
      // What scrolls sideways on purpose: code, a diff, and the composer's formatting row (D-181), which
      // is one row on a phone and says so with its scrollbar.
      if (element.closest('pre, [data-diff], [role="toolbar"]') !== null) continue;
      const { overflowX } = getComputedStyle(element);
      if (overflowX !== 'auto' && overflowX !== 'scroll') continue;
      widest = Math.max(widest, element.scrollWidth - element.clientWidth);
    }
    return widest;
  });

/**
 * The hints under a list of suggestions (the command list's, the `@` list's), side by side where they
 * fit and each on a line of its own where they do not: two hints beside each other may not wrap, or
 * they are two narrow columns broken at odd places. Returns each pair that does.
 */
const hintsInColumns = async (hints: Locator): Promise<string[]> =>
  await hints.evaluate((row) => {
    const items = [...row.children]
      .map((item) => ({
        text: item.textContent.trim(),
        box: item.getBoundingClientRect(),
        line: Number.parseFloat(getComputedStyle(item).lineHeight),
      }))
      .filter((item) => item.box.width > 0);
    const wraps = (item: (typeof items)[number]): boolean => item.box.height > item.line * 1.5;
    const columns: string[] = [];
    items.forEach((one, index) => {
      for (const other of items.slice(index + 1)) {
        const sameRow = one.box.top < other.box.bottom && other.box.top < one.box.bottom;
        if (sameRow && (wraps(one) || wraps(other))) columns.push(`${one.text} | ${other.text}`);
      }
    });
    return columns;
  });

test.describe('at a phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('nothing runs off the side of any screen', async ({ page, signIn, world }) => {
    // Bob, not the viewer the seeded-data spec asserts about: opening a channel marks it read, and a
    // spec that changes what another spec expects makes both depend on the order they ran in.
    await signIn('bob');
    const slug = world.workspace.slug;
    const screens: [string, string][] = [
      ['a channel with code and threads', channelPath(slug, world.channels.api)],
      ['a long channel', channelPath(slug, world.channels.deploys)],
      ['an empty channel', channelPath(slug, world.channels.design)],
      ['the open questions', `/w/${slug}/questions`],
      ['an address that is nowhere', '/nowhere'],
    ];
    for (const [name, path] of screens) {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(
        await horizontalOverflow(page),
        `${name} (${path}) is wider than the window`,
      ).toBeLessThanOrEqual(0);
    }
  });

  test("a channel's name has its room in the header, drawn under nothing", async ({
    page,
    signIn,
    world,
  }) => {
    // Found by hand (#624): "api" drawn over "Open questions 3". The document did not overflow, so
    // the test above could not see it — the header's own controls overlapped inside it.
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) });
    const name = header.getByRole('heading', { level: 1 }).getByRole('button');
    await expect(name).toBeVisible();
    const measured = await header.evaluate((element) => {
      const title = element.querySelector('h1 button');
      if (title === null) throw new Error('no channel name in the header');
      const box = title.getBoundingClientRect();
      const overlapping = [...element.querySelectorAll('a, button')]
        .filter((control) => !control.closest('h1') && control.getBoundingClientRect().width > 0)
        .filter((control) => {
          const other = control.getBoundingClientRect();
          return other.left < box.right && other.right > box.left;
        })
        .map((control) => control.getAttribute('aria-label') ?? control.textContent);
      return { overlapping, cut: title.scrollWidth > title.clientWidth };
    });
    expect(measured.overlapping, 'controls drawn over the name').toEqual([]);
    expect(measured.cut, 'a three-letter name is cut short').toBe(false);
  });

  test('a long channel name is cut with an ellipsis, drawn under nothing, and nothing leaves the header', async ({
    page,
    signIn,
    room,
  }) => {
    // Found by an audit: a fifteen-letter name ran under the open-questions control, because the name
    // would not shrink and so overflowed its box rather than being cut.
    const made = await room({ members: ['dogancan', 'bob'] });
    await signIn('dogancan');
    await page.goto(made.path);
    const header = page.locator('header').filter({ has: page.getByRole('heading', { level: 1 }) });
    await expect(header.getByRole('heading', { level: 1 })).toContainText(made.name.slice(0, 4));
    const measured = await header.evaluate((element) => {
      const title = element.querySelector('h1 button');
      if (title === null) throw new Error('no channel name in the header');
      const box = title.getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll('a, button')].filter(
        (control) => !control.closest('h1') && control.getBoundingClientRect().width > 0,
      );
      return {
        overlapping: controls
          .filter((control) => {
            const other = control.getBoundingClientRect();
            return other.left < box.right && other.right > box.left;
          })
          .map((control) => control.getAttribute('aria-label') ?? control.textContent),
        outside: controls
          .filter((control) => control.getBoundingClientRect().right > bounds.right + 0.5)
          .map((control) => control.getAttribute('aria-label') ?? control.textContent),
        cut: title.scrollWidth > title.clientWidth,
        ellipsis: getComputedStyle(title).textOverflow,
      };
    });
    expect(measured.overlapping, 'controls drawn over the name').toEqual([]);
    expect(measured.outside, 'controls pushed out of the header').toEqual([]);
    if (measured.cut) expect(measured.ellipsis, 'a cut name ends in an ellipsis').toBe('ellipsis');
  });

  test("every screen's title has its room in its header, drawn under nothing", async ({
    page,
    signIn,
    world,
  }) => {
    // The channel's header above, for each screen with a header of its own: Saved's three tabs were
    // drawn over its title at this width (#681), a screen the test above does not visit.
    await signIn('bob');
    const slug = world.workspace.slug;
    for (const screen of ['saved', 'inbox', 'questions', 'search']) {
      await page.goto(`/w/${slug}/${screen}`);
      const title = page.locator('header h1');
      await expect(title).toBeVisible();
      const measured = await title.evaluate((heading) => {
        const header = heading.closest('header');
        if (header === null) throw new Error('the title is not in a header');
        const box = heading.getBoundingClientRect();
        const overlapping = [...header.querySelectorAll('a, button')]
          .filter((control) => !heading.contains(control))
          .map((control) => ({ control, other: control.getBoundingClientRect() }))
          .filter(({ other }) => other.width > 0)
          .filter(
            ({ other }) =>
              other.left < box.right &&
              other.right > box.left &&
              other.top < box.bottom &&
              other.bottom > box.top,
          )
          .map(({ control }) => control.getAttribute('aria-label') ?? control.textContent);
        return {
          overlapping,
          cut: heading.scrollWidth > heading.clientWidth,
          outside: box.right > header.getBoundingClientRect().right,
        };
      });
      expect(measured.overlapping, `${screen}: controls drawn over the title`).toEqual([]);
      expect(measured.cut, `${screen}: the title is cut short`).toBe(false);
      expect(measured.outside, `${screen}: the title runs out of its header`).toBe(false);
    }
  });

  test("an open question's excerpt has the row's width: its reply pill is on the author's line", async ({
    page,
    signIn,
    world,
  }) => {
    // At this width the pill was a column of its own, leaving the question two words a line (#688).
    await signIn('bob');
    await page.goto(`/w/${world.workspace.slug}/questions`);
    const row = page.getByRole('main').getByRole('listitem').first();
    await expect(row).toBeVisible();
    const measured = await row.evaluate((item) => {
      const button = item.querySelector('button');
      if (button === null) throw new Error('no question in the row');
      const pill = [...button.querySelectorAll('span')].find((span) =>
        /^\d+ repl/.test(span.textContent),
      );
      // The question's words: the row's one block-level line.
      const excerpt = button.querySelector('span.block');
      if (pill === undefined || excerpt === null) {
        throw new Error('the row has no pill or no excerpt');
      }
      return {
        pillBottom: pill.getBoundingClientRect().bottom,
        excerptTop: excerpt.getBoundingClientRect().top,
        excerptRight: excerpt.getBoundingClientRect().right,
        pillLeft: pill.getBoundingClientRect().left,
      };
    });
    expect(measured.excerptRight, 'the excerpt stops short of the pill').toBeGreaterThan(
      measured.pillLeft,
    );
    expect(measured.pillBottom, 'the pill is beside the excerpt').toBeLessThanOrEqual(
      measured.excerptTop + 1,
    );
  });

  test('an open thread covers the conversation, runs off no side, and Close is a finger wide and brings it back', async ({
    page,
    signIn,
    world,
  }) => {
    // Found by hand when threads were inline: "N replies", Resolve and Collapse on one line were
    // wider than a phone. In the panel (D-122) the status and Resolve wrap the same way.
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    await page
      .getByRole('button', { name: /^Open · \d+ repl/ })
      .first()
      .click();
    const panel = page.getByRole('complementary', { name: /^Thread · / });
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(Math.round(box?.x ?? -1)).toBe(0);
    expect(Math.round(box?.width ?? -1)).toBe(390);
    expect(
      await horizontalOverflow(page),
      'the open thread is wider than the window',
    ).toBeLessThanOrEqual(0);
    const close = panel.getByRole('button', { name: 'Close thread' });
    const target = await close.boundingBox();
    expect(target?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(target?.height ?? 0).toBeGreaterThanOrEqual(44);
    await close.click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole('feed')).toBeVisible();
  });

  test('the composer is as tall focused as not: its hints are not drawn on a phone, and are still said', async ({
    page,
    signIn,
    world,
  }) => {
    // #643 gave the hints a row of their own here, so focusing the composer made it taller, the feed
    // above shrank, and a reader at the bottom was no longer there (#654). A phone's keyboard has no
    // Shift+Enter; a screen reader still hears the hints as the field's description.
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    const box = page.getByRole('textbox', { name: /^Message/ });
    // What a reader loses when the composer grows is the feed's height, so that is what is measured.
    // The composer is focused as the channel opens; the measurement starts from it unfocused. Shifted
    // on blur, the pill above it moved between a press and its release, and the click missed it.
    const feed = page.getByRole('feed').locator('..');
    await expect(feed).toBeVisible();
    await page.getByRole('main').focus();
    await expect(box).not.toBeFocused();
    const frames = async (): Promise<void> => {
      await page.evaluate(
        async () =>
          await new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }),
      );
    };
    await frames();
    const before = await feed.evaluate((element) => element.clientHeight);
    await box.focus();
    await expect(box).toBeFocused();
    // The focused state is React's to draw: measured after two frames, not in the same one.
    await frames();
    expect(await feed.evaluate((element) => element.clientHeight)).toBe(before);
    await expect(page.locator('kbd').filter({ hasText: 'Shift+Enter' })).toBeHidden();
    await expect(box).toHaveAccessibleDescription(/Enter sends/);
  });

  test('the sign-in screen fits too', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("an inbox row's first line is one line: the time never breaks, the reason gives way", async ({
    page,
    signIn,
    room,
    tenant,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'carol'] });
    await api('carol').say(made.id, `@dogancan a mention to lay out in ${made.name}`);
    await signIn();
    await page.goto(`/w/${tenant.slug}/inbox`);
    const row = page.getByRole('button', { name: new RegExp(made.name) });
    await expect(row).toContainText('Carol Reyes mentioned you');
    // The line the time sits on: one line tall, and the time one box on it (#679).
    const line = await row.locator('time').evaluate((time) => {
      const parent = time.parentElement;
      if (parent === null) throw new Error('the time has no line');
      return {
        height: parent.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(parent).lineHeight),
        boxes: time.getClientRects().length,
        timeHeight: time.getBoundingClientRect().height,
        timeLine: Number.parseFloat(getComputedStyle(time).lineHeight),
      };
    });
    expect(line.boxes).toBe(1);
    expect(line.timeHeight).toBeLessThan(line.timeLine * 1.5);
    expect(line.height).toBeLessThan(line.lineHeight * 1.5);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('the command list’s hints are lines of words under it, not two narrow columns', async ({
    page,
    signIn,
    world,
  }) => {
    // Found in an audit: at this width "Tab complete" and "// at the start sends a slash as words"
    // were two columns side by side, each broken every word or two.
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    const box = page.getByRole('textbox', { name: /^Message/ });
    await box.click();
    await box.pressSequentially('/');
    const list = page.getByRole('listbox', { name: 'Commands' });
    await expect(list).toBeVisible();
    const hints = list.locator('xpath=following-sibling::*[1]');
    await expect(hints).toContainText('at the start sends a slash as words');
    expect(await hintsInColumns(hints)).toEqual([]);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test.describe('the overlay', () => {
    test.beforeEach(async ({ page, signIn, world }) => {
      await signIn('bob');
      await page.goto(channelPath(world.workspace.slug, world.channels.api));
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });

    test('is not on the page until the toggle opens it, and is clean when it is', async ({
      page,
      expectNoAxe,
    }) => {
      await expect(page.locator('aside')).toHaveCount(0);
      // The rail goes with the sidebar: 56px of a phone's width is not given to it (D-110).
      await expect(page.getByRole('navigation', { name: 'Places' })).toHaveCount(0);
      const toggle = page.getByRole('button', { name: 'Open navigation' });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await toggle.click();
      const panel = page.getByRole('dialog', { name: 'Workspace' });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('navigation', { name: 'Places' })).toBeVisible();
      await expect(panel.locator('aside')).toBeVisible();
      // Radix hides the page behind the panel from the accessibility tree, the toggle included, so
      // it is found by its attribute and not by its role.
      await expect(page.locator('button[aria-haspopup="dialog"]')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await expectNoAxe(panel);
    });

    test('keeps focus inside while it is open, however long the person tabs', async ({ page }) => {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      const panel = page.getByRole('dialog', { name: 'Workspace' });
      await expect(panel).toBeVisible();
      for (let step = 0; step < 40; step++) {
        await page.keyboard.press('Tab');
        const inside = await panel.evaluate((node) => node.contains(document.activeElement));
        expect(inside, `focus left the panel on Tab ${String(step + 1)}`).toBe(true);
      }
    });

    test('Escape closes it and focus returns to the toggle', async ({ page }) => {
      const toggle = page.getByRole('button', { name: 'Open navigation' });
      await toggle.click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(toggle).toBeFocused();
    });

    test('a click on the scrim closes it', async ({ page }) => {
      const toggle = page.getByRole('button', { name: 'Open navigation' });
      await toggle.click();
      await expect(page.getByRole('dialog', { name: 'Workspace' })).toBeVisible();
      // The panel is the rail and the sidebar, 296px wide; the scrim is everything to its right. Radix starts listening for a
      // press outside a moment after the panel mounts, so a click in that first moment is a click
      // on nothing: the click is repeated until the panel answers, which is what a person does.
      await expect(async () => {
        await page.mouse.click(380, 420);
        await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 500 });
      }).toPass({ timeout: 5000 });
      await expect(toggle).toBeFocused();
    });

    test('choosing a channel closes it and puts focus on the page', async ({ page, world }) => {
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page
        .getByRole('link', { name: /deploys/ })
        .first()
        .click();
      await expect(page).toHaveURL(new RegExp(world.channels.deploys));
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('main')).toBeFocused();
    });

    test('every control in it, and the toggle, is at least a finger wide', async ({ page }) => {
      const toggle = page.getByRole('button', { name: 'Open navigation' });
      const box = await toggle.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      await toggle.click();
      const panel = page.getByRole('dialog', { name: 'Workspace' });
      await expect(panel).toBeVisible();
      const small = await panel.evaluate((node) =>
        [...node.querySelectorAll('a, button')]
          .map((element) => ({
            name: (element.getAttribute('aria-label') ?? element.textContent).trim().slice(0, 30),
            height: element.getBoundingClientRect().height,
            width: element.getBoundingClientRect().width,
          }))
          .filter((target) => target.height > 0 && (target.height < 43.5 || target.width < 43.5)),
      );
      expect(small).toEqual([]);
    });
  });
});

test.describe('crossing the line', () => {
  test('the sidebar is in the layout when wide and an overlay when narrow, with no leftover', async ({
    page,
    signIn,
    world,
  }) => {
    await signIn('bob');
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    await expect(page.locator('aside')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeHidden();

    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.locator('aside')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.setViewportSize({ width: 1200, height: 800 });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('aside')).toHaveCount(1);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });

  test('desktop density is what it was: a list row is the row height, not a finger', async ({
    page,
    signIn,
    world,
  }) => {
    await signIn('bob');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    const row = page.locator('aside nav a').first();
    await expect(row).toBeVisible();
    expect((await row.boundingBox())?.height).toBe(32); // `size-row` (D-110)
  });
});
