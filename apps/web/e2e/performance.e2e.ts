/**
 * The latency budgets of `PRD.md` §5 that a browser can measure (D-17, D-49): recorded on
 * every run and held to a threshold here because a number nobody reads is not a budget.
 *
 * - **Cold load to an interactive channel, < 1.5 s** with a warm cache — the first
 *   visit's downloads are cached by the browser (hashed assets are immutable), so the
 *   second visit measures what a person returning to the tab gets.
 * - **Keystroke → own message painted, < 16 ms** — one frame, never awaiting the network.
 *   Needs the composer; written now, enabled when it lands.
 * - **Channel switch with 50 cached messages, < 100 ms.** Needs the feed; same.
 *
 * Thresholds are the product's; the machine is a developer's laptop or a shared runner, so
 * the numbers are also attached to the report (`info.annotations`) where a regression that
 * is still under the line can be seen.
 */
import { expect, test, timeToPaint } from './fixtures';

test.describe('cold load', () => {
  test('to an interactive channel with a warm cache is under a second and a half', async ({
    page,
    signIn,
    world,
  }, info) => {
    // Bob, not the viewer whose unread state the seeded-data spec asserts: a visit can mark a channel read.
    await signIn('bob');
    const route = `/w/${world.workspace.slug}/c/${world.channels.api}`;
    // The frame is the sidebar, or — below the breakpoint, where it is an overlay — the toggle that opens it.
    const frame = page
      .getByRole('complementary')
      .or(page.getByRole('button', { name: 'Open navigation' }));
    // Warm: the first visit puts the bundle in the browser's cache.
    await page.goto(route);
    await expect(frame).toBeVisible();

    const started = performance.now();
    await page.goto(route, { waitUntil: 'commit' });
    // Interactive: the frame is there, and the page answers a key press.
    await expect(frame).toBeVisible();
    await page.keyboard.press('Tab');
    const elapsed = performance.now() - started;
    const navigation = await page.evaluate(() => {
      const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      return {
        responseStart: entry?.responseStart ?? -1,
        domInteractive: entry?.domInteractive ?? -1,
        loadEventEnd: entry?.loadEventEnd ?? -1,
      };
    });
    info.annotations.push({
      type: 'cold-load',
      description: `${elapsed.toFixed(0)} ms to an interactive channel (ttfb ${navigation.responseStart.toFixed(0)}, dom interactive ${navigation.domInteractive.toFixed(0)}, load ${navigation.loadEventEnd.toFixed(0)})`,
    });
    expect(elapsed).toBeLessThan(1_500);
  });
});

test.describe('interaction latency', () => {
  test.fixme('a keystroke paints its own message within one frame (16 ms), never awaiting the network', async ({
    page,
    signIn,
    world,
  }, info) => {
    // Enabled with the composer (F2b): type into it, press Enter, and the pending row
    // must be on screen two animation frames later even though the API is made to wait.
    await signIn();
    await page.route('**/api/channels/*/messages', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.continue();
    });
    await page.goto(`/w/${world.workspace.slug}/c/${world.channels.design}`);
    const box = page.getByRole('textbox', { name: /Message/ });
    await box.fill('painted before the network answers');
    const elapsed = await timeToPaint(page, async () => {
      await box.press('Enter');
    });
    info.annotations.push({ type: 'keystroke-to-paint', description: `${elapsed.toFixed(1)} ms` });
    await expect(page.getByText('painted before the network answers')).toBeVisible();
    expect(elapsed).toBeLessThan(16);
  });

  test.fixme('switching to a channel whose 50 newest messages are cached takes under 100 ms', async ({
    page,
    signIn,
    world,
  }, info) => {
    // Enabled with the feed (F2a): visit #api, then #deploys (both cached), then switch
    // between them and time to the first row of the other being painted.
    await signIn();
    await page.goto(`/w/${world.workspace.slug}/c/${world.channels.api}`);
    await page.goto(`/w/${world.workspace.slug}/c/${world.channels.deploys}`);
    const elapsed = await timeToPaint(page, async () => {
      await page.getByRole('link', { name: 'api' }).click();
    });
    info.annotations.push({ type: 'channel-switch', description: `${elapsed.toFixed(1)} ms` });
    expect(elapsed).toBeLessThan(100);
  });
});
