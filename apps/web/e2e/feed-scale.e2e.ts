/**
 * The feed at its worst, measured (O-5, D-199): a channel of two thousand heavy messages — code,
 * long markdown, pull-request cards, pictures, roots with replies — read back through the real client.
 *
 * Whether the feed is virtualized was decided against one number, the channel switch of `PRD.md` §5 (100 ms),
 * and a window of fifty messages is not what a person ends with: scrolling up reads older pages and the
 * feed keeps every one of them mounted. So the test does what a person does — opens the channel, scrolls to
 * the top over and over, goes to another channel and comes back — and at each size (the 50-message window,
 * about 500 loaded, about 2000) reads the four things the decision rests on:
 *
 * - the **channel switch back** to that channel after it was read that far (p95, in the page), and what it
 *   draws on return — a window, never the history (`keepNewestPage`);
 * - the **pagination**: from the top coming into view to the older page's rows drawn;
 * - **memory**: the elements in the document and the JavaScript heap, in view with everything read mounted;
 * - the **keystroke**: from a key in the composer to the frame that carries it.
 *
 * It is a measurement before it is a test: every figure is written to `test-results/performance/` and the
 * switch back after 2000 loaded messages and the keystroke at 500 are held to their lines on a person's machine, by the
 * same rule as `performance.e2e.ts` (D-49). On a shared runner `bun run budget:browser` judges them against
 * main's last runs.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { messageId, PAGE_LIMIT } from '@purlay/types';
import { expect, test } from './fixtures';
import { apiAs, isNarrow, type Persona, type Tenant } from './support';

/** A 2×2 PNG: a real image the API decodes and re-encodes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==',
  'base64',
);

const TOTAL = 2_000;
/** Loaded messages at which the feed is read again: the window, then what a long scroll leaves. */
const STAGES = [500, 2_000] as const;

const wallClock = (): Date => new Date(performance.timeOrigin + performance.now());

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
};

const summary = (values: readonly number[]): { p50: number; p95: number; max: number } => ({
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  max: Math.max(...values),
});

const underTheLine = (value: number, line: number): void => {
  if (process.env['CI'] === undefined) expect(value).toBeLessThan(line);
};

const CODE = [
  'export const pages = async (channelId: string, before?: string): Promise<Page> => {',
  '  const response = await fetch(`/api/channels/${channelId}/messages?before=${before ?? ""}`);',
  '  if (!response.ok) throw new Error(`the page answered ${String(response.status)}`);',
  '  const page = (await response.json()) as Page;',
  '  for (const message of page.data) {',
  '    if (message.deletedAt !== null) continue;',
  '    cache.set(message.id, message);',
  '  }',
  '  return page;',
  '};',
].join('\n');

const LONG = [
  '## What changed',
  '',
  'The **reader** is moved by *nothing* that arrives below them, and `anchor` is kept on the line they were reading.',
  '',
  '- the first thing, with a [link](https://example.com/one) in it',
  '- the second thing, which is long enough to wrap onto a second line at a narrow width, and then a little more',
  '- the third thing',
  '',
  '1. one',
  '2. two',
  '3. three',
  '',
  '> a quotation that someone pasted from the review, with `code` inside it and a second sentence that wraps',
  '',
  'And a closing paragraph that says what to do next, and who to ask, and by when, in enough words to be a paragraph.',
].join('\n');

type Kind = 'image' | 'code' | 'long' | 'cards' | 'thread' | 'plain';
/** Eight of ten messages are heavy; the rest are what most of a channel is. */
const KINDS: readonly Kind[] = [
  'image',
  'code',
  'long',
  'cards',
  'thread',
  'code',
  'long',
  'cards',
  'plain',
  'plain',
];

const textFor = (kind: Kind, index: number): string => {
  const label = `scale ${String(index).padStart(4, '0')}`;
  switch (kind) {
    case 'code':
      return `${label}\n\n\`\`\`ts\n${CODE}\n\`\`\``;
    case 'long':
      return `${label}\n\n${LONG}`;
    case 'cards':
      return `${label} see https://github.com/purlay/purlay/pull/${String(1000 + index)} and https://github.com/purlay/purlay/issues/${String(2000 + index)}`;
    case 'image':
      return `${label} a picture`;
    case 'thread':
      return `${label} a question with answers under it`;
    case 'plain':
      return `${label} an ordinary line of conversation about nothing in particular`;
  }
};

const upload = async (tenant: Tenant, who: Persona): Promise<string> => {
  const id = messageId(wallClock());
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(
      `${tenant.baseURL}/api/workspaces/${tenant.workspaceId}/uploads?id=${id}&name=picture.png`,
      {
        method: 'POST',
        headers: {
          cookie: `__Host-purlay_session=${tenant.tokens[who]}`,
          'content-type': 'application/octet-stream',
        },
        body: PNG,
      },
    );
    if (response.status === 429) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      continue;
    }
    if (!response.ok) throw new Error(`upload answered ${String(response.status)}`);
    return id;
  }
  throw new Error('upload stayed rate limited');
};

/** Two thousand messages in order, by the two people who are not driving the page. */
const seed = async (tenant: Tenant, channelId: string): Promise<void> => {
  const people: readonly Persona[] = ['carol', 'bob'];
  for (let round = 0; round < TOTAL; round += people.length) {
    await Promise.all(
      people.map(async (who, lane) => {
        const index = round + lane + 1;
        if (index > TOTAL) return;
        // The newest fifty are all heavy: the window a person opens the channel at.
        const kind =
          index > TOTAL - 50
            ? (KINDS[index % 8] ?? 'code')
            : (KINDS[index % KINDS.length] ?? 'plain');
        const api = apiAs(tenant, who);
        const attachmentIds = kind === 'image' ? [await upload(tenant, who)] : undefined;
        const sent = await api.post<{ id: string }>(`/api/channels/${channelId}/messages`, {
          id: messageId(wallClock()),
          content: textFor(kind, index),
          ...(attachmentIds === undefined ? {} : { attachmentIds }),
        });
        if (kind === 'thread') {
          const other = apiAs(tenant, people[(lane + 1) % 2] ?? 'bob');
          for (const reply of ['first answer', 'second answer', 'third answer']) {
            await other.say(channelId, `${reply} to ${String(index)}`, { parentId: sent.id });
          }
        }
      }),
    );
  }
};

const record = (name: string, project: string, numbers: unknown): void => {
  const folder = join(import.meta.dirname, '..', 'test-results', 'performance');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${name}-${project}.json`), JSON.stringify(numbers, null, 2));
};

test.describe('a long, heavy channel (O-5, D-199)', () => {
  test('the switch, the pagination, the memory and the keystroke at 50, about 500 and about 2000 loaded messages', async ({
    page,
    signIn,
    room,
    tenant,
    context,
  }, info) => {
    test.skip(
      ['webkit', 'firefox'].includes(info.project.name),
      'the heap is read through a CDP session, which only Chromium has',
    );
    test.skip(
      isNarrow(page),
      "switches by the sidebar's links, which at this width are in an overlay behind a toggle; the scale does not depend on the width",
    );
    test.setTimeout(900_000);

    const long = await room({ members: ['alice', 'bob', 'carol'] });
    const light = await room({ members: ['alice', 'bob', 'carol'] });
    await seed(tenant, long.id);
    await apiAs(tenant, 'carol').say(light.id, 'a light channel to switch away to');

    // Cards come from GitHub through the server; here from the test, so every card draws.
    await page.route('**/api/integrations/github/unfurl', async (route) => {
      const { url } = route.request().postDataJSON() as { url: string };
      const number = Number(/\/(\d+)$/.exec(url)?.[1] ?? '1');
      await route.fulfill({
        json: {
          type: url.includes('/pull/') ? 'pr' : 'issue',
          repo: 'purlay/purlay',
          number,
          title: `A title long enough to be a title, number ${String(number)}`,
          state: 'open',
          author: { login: 'carol', avatarUrl: '' },
          ...(url.includes('/pull/') ? { ciStatus: 'success', reviewDecision: 'approved' } : {}),
        },
      });
    });

    await signIn('alice');
    await page.goto(long.path);
    await expect(page.locator('[data-message-row]').last()).toBeVisible();

    const loaded = (): Promise<number> =>
      page.evaluate(() => document.querySelectorAll('[data-message-row]').length);
    const elements = (): Promise<number> =>
      page.evaluate(() => document.getElementsByTagName('*').length);

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    // The collector's own count, not `performance.memory`, which is coarsened to hide what it measures.
    const heapMB = async (): Promise<number> => {
      await cdp.send('HeapProfiler.collectGarbage');
      const { metrics } = await cdp.send('Performance.getMetrics');
      return (
        (metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value ?? Number.NaN) / 1e6
      );
    };

    /** A switch to the other channel's link, to the frame that draws the rows of the channel. */
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

    /** Twenty switches away and back; what is timed is the way back to the long channel. */
    const switchBack = async (): Promise<ReturnType<typeof summary>> => {
      const timings: number[] = [];
      for (let index = 0; index < 20; index++) {
        await switchTo(light);
        await page.waitForTimeout(60);
        timings.push(await switchTo(long));
        await page.waitForTimeout(60);
      }
      return summary(timings);
    };

    /** Keys typed into the composer, each from its keydown to the frame that follows its input. */
    const keystrokes = async (): Promise<ReturnType<typeof summary>> => {
      const box = page.getByRole('textbox', { name: /^Message/ });
      await box.click();
      await page.evaluate(() => {
        const marks: number[] = [];
        (window as unknown as { __keys: number[] }).__keys = marks;
        let down = 0;
        document.addEventListener(
          'keydown',
          (event) => {
            down = event.timeStamp;
          },
          true,
        );
        document.addEventListener(
          'input',
          () => {
            const from = down;
            requestAnimationFrame(() => {
              marks.push(performance.now() - from);
            });
          },
          true,
        );
      });
      for (const key of 'the quick brown fox jumps over') {
        await page.keyboard.press(key === ' ' ? 'Space' : key);
        await page.waitForTimeout(30);
      }
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __keys: number[] }).__keys.length))
        .toBeGreaterThanOrEqual(30);
      const marks = await page.evaluate(() => (window as unknown as { __keys: number[] }).__keys);
      await box.fill('');
      return summary(marks);
    };

    /**
     * Scrolls to the top until `count` messages are loaded; the time each older page took, from the top
     * being reached to the rows of the page being drawn and a frame after them.
     */
    const paginate = (count: number): Promise<number[]> =>
      page.evaluate(
        (wanted) =>
          new Promise<number[]>((resolve, reject) => {
            const scroller = document.querySelector('[role=feed]')?.parentElement;
            if (scroller === null || scroller === undefined) {
              reject(new Error('no feed'));
              return;
            }
            const timings: number[] = [];
            const rows = (): number => document.querySelectorAll('[data-message-row]').length;
            const next = (): void => {
              const before = rows();
              if (before >= wanted) {
                resolve(timings);
                return;
              }
              const started = performance.now();
              scroller.scrollTop = 0;
              const poll = (): void => {
                if (rows() > before) {
                  requestAnimationFrame(() => {
                    timings.push(performance.now() - started);
                    setTimeout(next, 80);
                  });
                  return;
                }
                if (performance.now() - started > 15_000) {
                  reject(new Error(`no older page after ${String(before)} messages`));
                  return;
                }
                requestAnimationFrame(poll);
              };
              requestAnimationFrame(poll);
            };
            next();
          }),
        count,
      );

    const numbers: Record<string, unknown> = {};
    const measure = async (label: string): Promise<void> => {
      // In view, with everything that was read still mounted.
      const mounted = await loaded();
      const nodes = await elements();
      const heap = await heapMB();
      const typed = await keystrokes();
      // Away and back: what the channel draws when it is returned to.
      const toggled = await switchBack();
      const returned = await loaded();
      numbers[label] = {
        rowsMounted: mounted,
        elements: nodes,
        heapMB: heap,
        keystroke: typed,
        switchBack: toggled,
        rowsAfterReturn: returned,
      };
      info.annotations.push({
        type: `feed-scale ${label}`,
        description: `${String(mounted)} rows, ${String(nodes)} elements, heap ${heap.toFixed(0)} MB · key p50 ${typed.p50.toFixed(1)} p95 ${typed.p95.toFixed(1)} ms · switch back p50 ${toggled.p50.toFixed(0)} p95 ${toggled.p95.toFixed(0)} ms, ${String(returned)} rows on return`,
      });
      // Not a time: a count, so a shared runner cannot excuse it. What is returned to is a window and not a history.
      expect(returned).toBeLessThanOrEqual(PAGE_LIMIT.default * 2);
    };

    // The window a person opens the channel at.
    await measure('window');
    const paginations: Record<string, ReturnType<typeof summary> & { pages: number }> = {};
    for (const stage of STAGES) {
      const taken = await paginate(stage);
      if (taken.length > 0) paginations[String(stage)] = { ...summary(taken), pages: taken.length };
      await measure(`loaded-${String(stage)}`);
    }
    numbers['pagination'] = paginations;
    record('feed-scale', info.project.name, numbers);

    // The lines, on a person's machine (D-49). The way back to the channel after two thousand messages were
    // read holds the switch's 100 ms; a keystroke with five hundred loaded holds two frames. With two
    // thousand still mounted in view the keystroke is only recorded — D-199 accepts it, with the number.
    const read = (label: string): { switchBack: { p95: number }; keystroke: { p95: number } } =>
      numbers[label] as { switchBack: { p95: number }; keystroke: { p95: number } };
    underTheLine(read(`loaded-${String(STAGES.at(-1))}`).switchBack.p95, 100);
    underTheLine(read('loaded-500').keystroke.p95, 33);
  });
});
