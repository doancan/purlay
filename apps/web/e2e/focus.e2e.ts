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
    // thread panel covers the channel and what it covers is out of the Tab order (D-126), so the
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
});
