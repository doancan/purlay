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
import { onEngine, shellReady, WEBKIT_TAB } from './support';

/** What the focused element shows, measured in the page: a ring on it or on one of its two parents. */
const ringOfFocused = async (
  page: Page,
): Promise<{ what: string; ring: number; besideItsLine: boolean }> =>
  await page.evaluate(() => {
    const element = document.activeElement;
    // Past the last stop the browser hands focus to the page itself: not a stop.
    if (!(element instanceof HTMLElement) || element === document.body) {
      return { what: 'nothing', ring: 0, besideItsLine: false };
    }
    const width = (node: Element): number => {
      const style = getComputedStyle(node);
      return style.outlineStyle === 'none' ? 0 : Number.parseFloat(style.outlineWidth);
    };
    // The composer's box draws its focus as its own edge turned a firmer grey, not as an outline: it counts as the
    // indicator when the edge is the focused colour (`composer-focus`) and not the resting one.
    const composerEdge = ((): number => {
      const card = element.closest<HTMLElement>('[data-composer-card]');
      if (card === null) return 0;
      const probe = document.createElement('span');
      probe.style.color = 'var(--composer-focus)';
      document.body.append(probe);
      const focusedColour = getComputedStyle(probe).color;
      probe.remove();
      return getComputedStyle(card).borderTopColor === focusedColour
        ? Number.parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue('--stroke-focus'),
          ) || 2
        : 0;
    })();
    const ring = Math.max(
      width(element),
      element.parentElement === null ? 0 : width(element.parentElement),
      element.parentElement?.parentElement == null ? 0 : width(element.parentElement.parentElement),
      composerEdge,
    );
    const name = element.getAttribute('aria-label') ?? element.textContent.trim().slice(0, 40);
    // An element with a line of its own that keeps the ring outside it, a gap between: two lines, which
    // reads as a mistake. The ring takes the line's place (the composer's way) — it is not offset outward.
    const own = getComputedStyle(element);
    // A line drawn in the element's own fill (a filled button's) is not a second line: the ring beside it is the only edge.
    const hasLine = ['Top', 'Right', 'Bottom', 'Left'].some(
      (side) =>
        Number.parseFloat(own.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
        own.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none' &&
        own.getPropertyValue(`border-${side.toLowerCase()}-color`) !== own.backgroundColor,
    );
    const besideItsLine =
      hasLine && own.outlineStyle !== 'none' && Number.parseFloat(own.outlineOffset) > 0;
    return { what: `${element.tagName.toLowerCase()} "${name}"`, ring, besideItsLine };
  });

test.describe('focus', () => {
  test('the skip link is wholly out of the window until it is focused, and then inside it', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    await shellReady(page);
    const link = page.getByRole('link', { name: /skip to the conversation/i });
    // Not at the edge with its bottom border showing: over a dialog's scrim that was a stray line.
    const resting = await link.boundingBox();
    expect(resting === null ? 0 : resting.y + resting.height).toBeLessThanOrEqual(0);
    await link.focus();
    const shown = await link.boundingBox();
    expect(shown === null ? -1 : shown.y).toBeGreaterThanOrEqual(0);
  });

  test('every Tab stop in a channel with a thread open shows a ring', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    test.skip(
      onEngine(test.info(), 'webkit', 'firefox'),
      `past the last element Firefox under Playwright keeps focus on it rather than going round (docs/spikes/cross-browser.md); and ${WEBKIT_TAB}`,
    );
    const made = await room({ members: ['dogancan', 'carol'] });
    const root = await api('carol').say(made.id, 'a question with an answer?');
    await api('carol').say(made.id, 'the answer', { parentId: root.id });
    await signIn();
    await page.goto(`${made.path}?thread=${root.id}`);
    await shellReady(page);
    await expect(page.locator(`[data-thread-root="${root.id}"]`)).toBeVisible();

    const unringed: string[] = [];
    const doubled: string[] = [];
    const seen = new Set<string>();
    for (let press = 0; press < 60; press++) {
      await page.keyboard.press('Tab');
      const stop = await ringOfFocused(page);
      if (stop.what === 'nothing' || seen.has(stop.what)) continue;
      seen.add(stop.what);
      if (stop.ring < 2) unringed.push(`${stop.what} (${String(stop.ring)}px)`);
      if (stop.besideItsLine) doubled.push(stop.what);
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
    // One line, not a line and a ring beside it.
    expect(doubled).toEqual([]);
  });

  test('every element already holds the ring colour, so a ring never fades in from the text colour', async ({
    page,
    signIn,
    room,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    await shellReady(page);
    // An outline's colour starts as the text's own, and `transition-colors` animates `outline-color`: a ring switched
    // on by `:focus-visible` faded from near-black (light) or near-white (dark) to the blue, flashing the wrong colour at
    // every Tab stop. The browser tests run with reduced motion, so the fade itself cannot be seen here; what makes it
    // possible can: an element whose colour is not the ring's *before* it is focused. Held for the elements that take
    // focus, and again after a pointer press, which switches the ring off with a rule of its own.
    const colours = async (): Promise<{ expected: string; stray: string[]; counted: number }> =>
      await page.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--focus-ring)';
        document.body.append(probe);
        const expected = getComputedStyle(probe).color;
        probe.remove();
        const stops = [
          ...document.querySelectorAll<HTMLElement>(
            'a[href], button, input, textarea, select, [tabindex]',
          ),
        ];
        const stray = stops
          .filter((element) => getComputedStyle(element).outlineColor !== expected)
          .map(
            (element) =>
              `${element.tagName.toLowerCase()} ${getComputedStyle(element).outlineColor}`,
          );
        return { expected, stray: [...new Set(stray)], counted: stops.length };
      });
    const before = await colours();
    expect(before.counted).toBeGreaterThan(10);
    expect(before.stray).toEqual([]);

    // A stop the keyboard reached, then a pointer press: the rule that withholds the ring from it must leave its colour.
    await page.keyboard.press('Tab');
    const reached = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null || element === document.body) return null;
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, colour: style.outlineColor };
    });
    // The Tab landed on a stop and drew its ring, in the ring's colour (Firefox's own focus ring resets it unless
    // the rule says it again): what the pointer press then withholds was really there.
    expect(reached).toEqual({ style: 'solid', colour: before.expected });
    await page.evaluate(() => {
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    await expect(page.locator('html')).toHaveAttribute('data-pointer', '');
    const hidden = await page.evaluate(() => {
      const element = document.activeElement;
      return element === null ? null : getComputedStyle(element).outlineStyle;
    });
    expect(hidden).toBe('none');
    const after = await colours();
    expect(after.stray).toEqual([]);
  });

  test('the feed is one Tab stop: its row, then that row’s own controls, then the composer (D-168)', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    test.skip(onEngine(test.info(), 'webkit'), WEBKIT_TAB);
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
    await expect(
      row(newest.id).getByRole('link', { name: 'https://example.com/newest' }),
    ).toBeVisible();
    await expect(row(older.id).locator('pre')).toBeVisible();
    // Shift+Tab from the composer: the feed's row, then out of the feed.
    await composer.focus();
    // The formatting row is one stop between them (a toolbar, D-181): the arrows walk its buttons.
    await page.keyboard.press('Shift+Tab');
    expect(await where()).toBe('outside Bold');
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
    expect(await where()).toBe('outside Bold');
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
    const link = row(newest.id).getByRole('link', { name: 'https://example.com/newest' });
    await expect(link).toHaveAttribute('tabindex', '-1');
    await page.context().route('https://example.com/**', (route) => route.fulfill({ body: 'ok' }));
    const [opened] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    expect(opened.url()).toContain('example.com/newest');
    await opened.close();
  });
});
