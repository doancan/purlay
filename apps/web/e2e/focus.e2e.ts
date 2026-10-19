/**
 * Focus is always visible (`UX.md` §7, #64): every stop the keyboard reaches, in the shell and in a
 * channel with a thread open, draws a ring at least the focus stroke wide — on itself, or on the
 * box that holds it when the box draws the ring for its field (`focus-within`, the composer).
 *
 * A rule held by remembering is a wish (CONTRIBUTING §6.2): an `outline-none` added without a ring
 * to replace it fails here, wherever it is, instead of in somebody's keyboard months later.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { shellReady } from './support';

/** What the focused element shows, measured in the page: a ring on it or on one of its two parents. */
const ringOfFocused = async (page: Page): Promise<{ what: string; ring: number }> =>
  await page.evaluate(() => {
    const element = document.activeElement;
    // Past the last stop the browser hands focus to the page itself: not a stop.
    if (!(element instanceof HTMLElement) || element === document.body) {
      return { what: 'nothing', ring: 0 };
    }
    const width = (node: Element): number => {
      const style = getComputedStyle(node);
      return style.outlineStyle === 'none' ? 0 : Number.parseFloat(style.outlineWidth);
    };
    const ring = Math.max(
      width(element),
      element.parentElement === null ? 0 : width(element.parentElement),
      element.parentElement?.parentElement == null ? 0 : width(element.parentElement.parentElement),
    );
    const name = element.getAttribute('aria-label') ?? element.textContent.trim().slice(0, 40);
    return { what: `${element.tagName.toLowerCase()} "${name}"`, ring };
  });

test.describe('focus', () => {
  test('every Tab stop in a channel with a thread open shows a ring', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    test.skip(
      ['webkit', 'firefox'].includes(test.info().project.name),
      "past the last element Firefox under Playwright keeps focus on it rather than going round, and macOS WebKit's Tab skips links (docs/spikes/cross-browser.md)",
    );
    const made = await room({ members: ['dogancan', 'carol'] });
    const root = await api('carol').say(made.id, 'a question with an answer?');
    await api('carol').say(made.id, 'the answer', { parentId: root.id });
    await signIn();
    await page.goto(`${made.path}?thread=${root.id}`);
    await shellReady(page);
    await expect(page.locator(`[data-thread-root="${root.id}"]`)).toBeVisible();

    const unringed: string[] = [];
    const seen = new Set<string>();
    for (let press = 0; press < 60; press++) {
      await page.keyboard.press('Tab');
      const stop = await ringOfFocused(page);
      if (stop.what === 'nothing' || seen.has(stop.what)) continue;
      seen.add(stop.what);
      if (stop.ring < 2) unringed.push(`${stop.what} (${String(stop.ring)}px)`);
    }
    // Enough of the page was crossed for the answer to mean something. On a narrow window the
    // thread panel covers the channel and what it covers is out of the Tab order (D-122), so the
    // page is the panel: its own controls were all reached, and nothing else was counted.
    if (test.info().project.name.includes('narrow')) {
      for (const control of [
        'button "Close thread"',
        'button "Resolve',
        'textarea "Message a thread in',
      ]) {
        const reached = [...seen].some((stop) => stop.startsWith(control));
        expect(reached, `${control} was not reached: ${[...seen].join(', ')}`).toBe(true);
      }
      expect(seen.size).toBeGreaterThan(4);
    } else {
      expect(seen.size).toBeGreaterThan(10);
    }
    expect(unringed).toEqual([]);
  });

  test('the feed is one Tab stop: its row, then that row’s own controls, then the composer (D-168)', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    test.skip(
      ['webkit'].includes(test.info().project.name),
      "macOS WebKit's Tab skips links and buttons unless the person turns on 'Press Tab to highlight each item' (docs/spikes/cross-browser.md)",
    );
    const made = await room({ members: ['dogancan', 'carol'] });
    const older = await api('carol').say(
      made.id,
      'see https://example.com/older and\n```ts\nconst a = 1;\n```',
    );
    await api('carol').react(older.id, '👀');
    const newest = await api('carol').say(made.id, 'the newest, with https://example.com/newest');
    await signIn();
    await page.goto(made.path);
    await shellReady(page);
    const composer = page.getByRole('textbox', { name: /^Message/ });
    const row = (id: string): ReturnType<Page['locator']> =>
      page.locator(`[data-message-row][data-message-id="${id}"]`);
    const where = async (): Promise<string> =>
      await page.evaluate(() => {
        const active = document.activeElement;
        if (!(active instanceof HTMLElement)) return 'nothing';
        const holder = active.closest<HTMLElement>('[data-message-row]');
        if (holder === active) return `row ${active.dataset['messageId'] ?? ''}`;
        if (active.matches('textarea')) return 'composer';
        const name = active.getAttribute('aria-label') ?? active.textContent.trim().slice(0, 40);
        return holder === null ? `outside ${name}` : `${holder.dataset['messageId'] ?? ''} ${name}`;
      });

    // Both messages drawn whole before the walk starts: a feed still loading has no row to land on.
    await expect(row(newest.id).getByRole('link', { name: /example.com\/newest/ })).toBeVisible();
    await expect(row(older.id).locator('pre')).toBeVisible();
    // Shift+Tab from the composer: the feed's row, then out of the feed.
    await composer.focus();
    await page.keyboard.press('Shift+Tab');
    expect(await where()).toBe(`row ${newest.id}`);
    expect((await ringOfFocused(page)).ring).toBeGreaterThanOrEqual(2);
    await page.keyboard.press('Shift+Tab');
    expect(await where()).toMatch(/^outside /);
    // Tab back in: the row, its link, its bar, the composer — nothing of the older message.
    await page.keyboard.press('Tab');
    expect(await where()).toBe(`row ${newest.id}`);
    const walk: string[] = [];
    for (let press = 0; press < 12; press++) {
      await page.keyboard.press('Tab');
      const stop = await where();
      walk.push(stop);
      if (stop === 'composer') break;
      expect((await ringOfFocused(page)).ring, stop).toBeGreaterThanOrEqual(2);
    }
    expect(walk.at(-1)).toBe('composer');
    expect(walk[0]).toContain('example.com/newest');
    expect(walk.filter((stop) => stop.startsWith(older.id))).toEqual([]);

    // ↑ to the older message: Tab walks its link, its code block and its chip, and only those.
    await page.keyboard.press('Shift+Tab');
    expect(await where()).toBe(`row ${newest.id}`);
    await page.keyboard.press('ArrowUp');
    expect(await where()).toBe(`row ${older.id}`);
    const inOlder: string[] = [];
    for (let press = 0; press < 14; press++) {
      await page.keyboard.press('Tab');
      const stop = await where();
      inOlder.push(stop);
      if (stop === 'composer') break;
      expect((await ringOfFocused(page)).ring, stop).toBeGreaterThanOrEqual(2);
    }
    expect(inOlder.at(-1)).toBe('composer');
    expect(inOlder[0]).toContain('example.com/older');
    expect(inOlder.some((stop) => stop.includes('Copy code'))).toBe(true);
    expect(inOlder.some((stop) => stop.includes('👀'))).toBe(true);
    expect(inOlder.filter((stop) => stop.startsWith(newest.id))).toEqual([]);

    // The pointer is not the keyboard: the newest message's link, out of the Tab order now, still opens.
    await composer.focus();
    const link = row(newest.id).getByRole('link', { name: /example.com\/newest/ });
    await expect(link).toHaveAttribute('tabindex', '-1');
    await page.context().route('https://example.com/**', (route) => route.fulfill({ body: 'ok' }));
    const [opened] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    expect(opened.url()).toContain('example.com/newest');
    await opened.close();
  });
});
