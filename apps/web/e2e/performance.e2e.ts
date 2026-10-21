/**
 * The latency budgets of `PRD.md` §5 that a browser can measure (D-17, D-49): recorded on
 * every run and held to a threshold here because a number nobody reads is not a budget. On a
 * shared runner (`CI`) the line is not the gate, by D-49: there the three latencies block on a
 * regression against main's last run instead (`bun run budget:browser`), because a hosted runner
 * measures the channel switch at 120–170 ms where a laptop measures 33.
 *
 * - **Cold load to an interactive channel, < 1.5 s** on the production build, with a warm
 *   browser cache (what a person returning to the tab gets) — the median of five loads.
 * - **Keystroke → own message painted, < 16 ms** — one frame, never awaiting the network —
 *   p95 over 20 sends, with the server's answers held for two seconds.
 * - **Channel switch with the newest messages cached, < 100 ms**, p95 over 20 switches.
 * - Measured and reported, not gated: long tasks during a scripted fling over 200 messages, and
 *   the heap after 100 switches.
 *
 * The in-page numbers are taken in the page, from the key event's own timestamp to the moment
 * the row is in the document and to the frame that carries it; Playwright's round trips are not
 * in them. Every figure is also written as JSON (`test-results/performance/`) and attached to the
 * report (`info.annotations`), where a regression that is still under the line can be seen.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { history, isNarrow, writeInParallel } from './support';

/** The p-th percentile (nearest rank) of a list of numbers. */
const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
};

/** D-49: the line on a person's machine; on a shared runner `budget:browser` judges the number. */
const underTheLine = (value: number, line: number): void => {
  if (process.env['CI'] === undefined) expect(value).toBeLessThan(line);
};

const summary = (values: readonly number[]): { p50: number; p95: number; max: number } => ({
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  max: Math.max(...values),
});

/** One JSON per figure and project, so a run leaves numbers behind. */
const record = (name: string, project: string, numbers: unknown): void => {
  const folder = join(import.meta.dirname, '..', 'test-results', 'performance');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${name}-${project}.json`), JSON.stringify(numbers, null, 2));
};

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
      .getByRole('complementary', { name: 'Workspace' })
      .or(page.getByRole('button', { name: 'Open navigation' }));
    // Warm: the first visit puts the bundle in the browser's cache.
    await page.goto(route);
    await expect(frame).toBeVisible();

    // Five loads, and their median: one load is one draw of a noisy machine, and a budget judged on
    // a single draw fails on the draw (D-49).
    const loads: number[] = [];
    for (let load = 0; load < 5; load++) {
      const started = performance.now();
      await page.goto(route, { waitUntil: 'commit' });
      // Interactive: the frame is there, and the page answers a key press.
      await expect(frame).toBeVisible();
      await page.keyboard.press('Tab');
      loads.push(performance.now() - started);
    }
    const elapsed = percentile(loads, 50);
    const navigation = await page.evaluate(() => {
      const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
      return {
        responseStart: entry?.responseStart ?? -1,
        domInteractive: entry?.domInteractive ?? -1,
        loadEventEnd: entry?.loadEventEnd ?? -1,
      };
    });
    record('cold-load', info.project.name, { elapsed, all: loads, ...navigation });
    info.annotations.push({
      type: 'cold-load',
      description: `${elapsed.toFixed(0)} ms to an interactive channel, the median of five (ttfb ${navigation.responseStart.toFixed(0)}, dom interactive ${navigation.domInteractive.toFixed(0)}, load ${navigation.loadEventEnd.toFixed(0)})`,
    });
    underTheLine(elapsed, 1_500);
  });
});

test.describe('interaction latency', () => {
  test('a keystroke paints its own message within one frame (16 ms), never awaiting the network — p95 over 20 sends', async ({
    page,
    signIn,
    room,
  }, info) => {
    test.setTimeout(90_000);
    // Alice sends: the write budget is per person, and twenty sends in a burst are the whole of it.
    const made = await room({ members: ['alice', 'bob'] });
    await signIn('alice');
    // The server's answers are held for two seconds: whatever paints sooner did not wait for them.
    await page.routeWebSocket(/\/ws$/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        server.send(message);
      });
      server.onMessage((message) => {
        setTimeout(() => {
          ws.send(message);
        }, 2_000);
      });
    });
    await page.goto(made.path);
    const box = page.getByRole('textbox', { name: /^Message/ });
    await expect(box).toBeVisible();
    await page.evaluate(() => {
      const marks: { text: string; down: number; dom: number; frame: number }[] = [];
      (window as unknown as { __marks: typeof marks }).__marks = marks;
      let down = 0;
      document.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Enter') down = event.timeStamp;
        },
        true,
      );
      new MutationObserver(() => {
        for (const row of document.querySelectorAll('[data-message-row]')) {
          const match = /probe (\d+)/.exec(row.textContent);
          if (match === null) continue;
          const key = match[0];
          if (marks.some((mark) => mark.text === key)) continue;
          const entry = { text: key, down, dom: performance.now(), frame: 0 };
          marks.push(entry);
          requestAnimationFrame(() => {
            entry.frame = performance.now();
          });
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    for (let index = 0; index < 20; index++) {
      await box.fill(`probe ${String(index)}`);
      await box.press('Enter');
      await page.waitForTimeout(120);
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __marks: { frame: number }[] }).__marks.filter(
              (mark) => mark.frame > 0,
            ).length,
        ),
      )
      .toBe(20);
    const marks = await page.evaluate(
      () =>
        (window as unknown as { __marks: { down: number; dom: number; frame: number }[] }).__marks,
    );
    const numbers = {
      toDocument: summary(marks.map((mark) => mark.dom - mark.down)),
      toNextFrame: summary(marks.map((mark) => mark.frame - mark.down)),
    };
    record('keystroke-to-paint', info.project.name, numbers);
    info.annotations.push({
      type: 'keystroke-to-paint',
      description: `row in the document p95 ${numbers.toDocument.p95.toFixed(1)} ms · carried by a frame p95 ${numbers.toNextFrame.p95.toFixed(1)} ms`,
    });
    underTheLine(numbers.toDocument.p95, 16);
    // The frame that carries it starts at most one frame after the work is done.
    underTheLine(numbers.toNextFrame.p95, 16 + 17);
  });

  test('switching to a channel whose newest messages are cached paints under 100 ms — p95 over 20 switches', async ({
    page,
    signIn,
    room,
    tenant,
  }, info) => {
    test.skip(
      isNarrow(page),
      "switches by the sidebar's links, which at this width are in an overlay behind a toggle: the switch there is the overlay's, measured by narrow.e2e",
    );
    test.setTimeout(120_000);
    const first = await room({ members: ['alice', 'bob', 'carol'] });
    const second = await room({ members: ['alice', 'bob', 'carol'] });
    await writeInParallel(tenant, first.id, history(60));
    await writeInParallel(tenant, second.id, history(60));
    await signIn('alice');
    await page.goto(first.path);
    await expect(page.locator('[data-message-row]').last()).toBeVisible();
    const switchTo = (target: { id: string; name: string }): Promise<number> =>
      page.evaluate(
        ({ id, name }) =>
          new Promise<number>((resolve) => {
            const link = document.querySelector<HTMLElement>(`aside a[href$="/c/${id}"]`);
            if (link === null) throw new Error('no link');
            const started = performance.now();
            const shown = (): boolean => {
              const feed = document.querySelector('[role=feed]');
              return (
                feed !== null &&
                feed.getAttribute('aria-label')?.includes(name) === true &&
                feed.querySelector('[data-message-row]') !== null
              );
            };
            const done = (): void => {
              requestAnimationFrame(() => {
                resolve(performance.now() - started);
              });
            };
            const watcher = new MutationObserver(() => {
              if (shown()) {
                watcher.disconnect();
                done();
              }
            });
            watcher.observe(document.body, { childList: true, subtree: true, attributes: true });
            link.click();
            if (shown()) {
              watcher.disconnect();
              done();
            }
          }),
        target,
      );
    // Each channel visited once in the app, so both are in the client's cache.
    await switchTo(second);
    await switchTo(first);
    const timings: number[] = [];
    for (let index = 0; index < 20; index++) {
      timings.push(await switchTo(index % 2 === 0 ? second : first));
      await page.waitForTimeout(60);
    }
    const numbers = summary(timings);
    record('channel-switch', info.project.name, { ...numbers, all: timings });
    info.annotations.push({
      type: 'channel-switch',
      description: `p50 ${numbers.p50.toFixed(1)} ms · p95 ${numbers.p95.toFixed(1)} ms · max ${numbers.max.toFixed(1)} ms`,
    });
    underTheLine(numbers.p95, 100);
    // The page measured each switch itself (O-5): what a week of real use is read from, with nothing
    // sent anywhere. Same order of magnitude as the test's own clock, which starts a click earlier.
    const inPage = await page.evaluate(() =>
      performance
        .getEntriesByName('purlay:channel-switch', 'measure')
        .map((entry) => entry.duration),
    );
    expect(inPage.length).toBeGreaterThanOrEqual(22);
    underTheLine(summary(inPage).p95, 100);
  });
});

test.describe('long scrolls and memory (measured and reported)', () => {
  test('a scripted fling over two hundred messages: long tasks counted; and the heap after a hundred switches', async ({
    page,
    signIn,
    room,
    tenant,
    context,
  }, info) => {
    test.skip(
      ['webkit', 'firefox'].includes(test.info().project.name),
      'the heap is read through a CDP session, which only Chromium has',
    );
    test.skip(
      isNarrow(page),
      "switches by the sidebar's links, which at this width are in an overlay behind a toggle: the switch there is the overlay's, measured by narrow.e2e",
    );
    test.setTimeout(180_000);
    const long = await room({ members: ['alice', 'bob', 'carol'] });
    const other = await room({ members: ['alice', 'bob', 'carol'] });
    await writeInParallel(tenant, long.id, history(200));
    await writeInParallel(tenant, other.id, history(60));
    await signIn('alice');
    await page.goto(long.path);
    await expect(page.locator('[data-message-row]').last()).toBeVisible();
    await page.evaluate(() => {
      const longTasks: number[] = [];
      (window as unknown as { __long: number[] }).__long = longTasks;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      }).observe({ type: 'longtask' });
    });
    // Up through the history in strides a hand would fling, loading older pages on the way,
    // then back down to the end.
    const scrolled = await page.evaluate(
      () =>
        new Promise<{ frames: number; rows: number }>((resolve) => {
          const scroller = document.querySelector('[role=feed]')?.parentElement;
          if (scroller === null || scroller === undefined) throw new Error('no feed');
          let frames = 0;
          let direction = -1;
          const step = (): void => {
            frames += 1;
            scroller.scrollTop += direction * 140;
            if (scroller.scrollTop <= 0 && direction === -1 && frames > 30) direction = 1;
            const atEnd =
              direction === 1 &&
              scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 4;
            if (frames > 900 || atEnd) {
              resolve({ frames, rows: document.querySelectorAll('[data-message-row]').length });
              return;
            }
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    const longTasks = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);

    const cdp = await context.newCDPSession(page);
    const heap = async (): Promise<number> => {
      await cdp.send('HeapProfiler.collectGarbage');
      return await page.evaluate(
        () =>
          (performance as unknown as { memory: { usedJSHeapSize: number } }).memory.usedJSHeapSize,
      );
    };
    await page.goto(other.path);
    await expect(page.locator('[data-message-row]').last()).toBeVisible();
    const before = await heap();
    for (let index = 0; index < 100; index++) {
      const target = index % 2 === 0 ? long : other;
      await page.evaluate((id) => {
        document.querySelector<HTMLElement>(`aside a[href$="/c/${id}"]`)?.click();
      }, target.id);
      await page.waitForTimeout(25);
    }
    const after = await heap();
    const numbers = {
      fling: {
        frames: scrolled.frames,
        rowsLoaded: scrolled.rows,
        longTasks: longTasks.length,
        longestMs: Math.max(0, ...longTasks),
      },
      memory: { beforeMB: before / 1e6, afterMB: after / 1e6, growthMB: (after - before) / 1e6 },
    };
    record('fling-and-memory', info.project.name, numbers);
    info.annotations.push({
      type: 'fling',
      description: `${String(scrolled.frames)} frames over ${String(scrolled.rows)} rows: ${String(longTasks.length)} long task(s), longest ${numbers.fling.longestMs.toFixed(0)} ms`,
    });
    info.annotations.push({
      type: 'memory',
      description: `${numbers.memory.beforeMB.toFixed(1)} MB → ${numbers.memory.afterMB.toFixed(1)} MB after 100 switches (${numbers.memory.growthMB.toFixed(1)} MB)`,
    });
    // Reported, with a ceiling that only a leak would reach.
    expect(numbers.memory.growthMB).toBeLessThan(25);
  });
});
