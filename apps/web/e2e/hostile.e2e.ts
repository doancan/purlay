/**
 * What anybody can put in a message must render as inert text (D-33 reasoning, on the client):
 * markup is shown, not run; a `javascript:` target is not a link; a string built to make a
 * pattern backtrack costs nothing; bidirectional controls and joiner chains cannot push the
 * layout out of its box. The page is judged by what a script would have left behind
 * (`window.__pwned`), by whether it still answers, and by whether anything scrolls sideways.
 */
import type { Page } from '@playwright/test';
import {
  MARKDOWN_DELIMITERS_MAX,
  MARKDOWN_NESTING_MAX,
  MARKDOWN_RUN_MAX,
  readMarkdown,
} from '@purlay/markdown';
import { MESSAGE_CONTENT_MAX } from '@purlay/types';
import { expect, test } from './fixtures';

const PAYLOADS: readonly { readonly name: string; readonly text: string }[] = [
  { name: 'script', text: '<script>window.__pwned = "script"</script> after the script' },
  { name: 'img-onerror', text: '<img src=x onerror="window.__pwned=\'img\'"> after the image' },
  { name: 'svg-onload', text: '<svg onload="window.__pwned=\'svg\'"></svg> after the svg' },
  { name: 'iframe', text: '<iframe src="javascript:window.__pwned=\'frame\'"></iframe> after' },
  { name: 'md-javascript', text: "[click me](javascript:window.__pwned='md') after the link" },
  { name: 'bare-javascript', text: "javascript:window.__pwned='bare' after the scheme" },
  { name: 'html-anchor', text: '<a href="javascript:window.__pwned=\'a\'">anchor</a> after' },
  { name: 'data-url', text: '[data](data:text/html,<script>window.__pwned=1</script>) after' },
  { name: 'md-image', text: '![x](javascript:window.__pwned=1) after the image' },
  { name: 'unbroken-16k', text: 'a'.repeat(16_000) },
  { name: 'markers-16k', text: '*_`~[]()<>'.repeat(1_600) },
  { name: 'links-16k', text: 'https://'.repeat(2_000) },
  { name: 'mentions-16k', text: '@a'.repeat(8_000) },
  { name: 'nested-16k', text: '['.repeat(4_000) + 'x' + ']('.repeat(4_000) },
  { name: 'rtl-override', text: 'before ‮evil‬ and ⁧embedded⁩ after' },
  { name: 'zwj-family', text: '👨‍👩‍👧‍👦'.repeat(500) },
  { name: 'zwj-chain', text: Array.from({ length: 300 }, () => '👩').join('‍') },
  { name: 'zero-width', text: 'a​'.repeat(4_000) },
  { name: 'combining', text: 'e' + '́'.repeat(3_000) },
];

const sidewaysScroll = (
  page: Page,
): Promise<{ readonly feed: number; readonly document: number }> =>
  page.evaluate(() => {
    const feed = document.querySelector('[role=feed]')?.parentElement;
    return {
      feed: feed === null || feed === undefined ? 0 : feed.scrollWidth - feed.clientWidth,
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

test.describe('hostile content', () => {
  test('renders as text: nothing runs, nothing links to a script, nothing scrolls sideways, and the page still answers', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    test.setTimeout(120_000);
    const made = await room({ members: ['dogancan', 'alice'] });
    for (const payload of PAYLOADS) await api('carol').say(made.id, payload.text);
    await signIn();
    await page.goto(made.path);
    await expect(page.locator('[data-message-row]').first()).toBeVisible();
    await expect(page.locator('[data-message-row]')).toHaveCount(PAYLOADS.length);

    // The page answers: a script that ran long, or a pattern that backtracked, would not.
    const answered = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const start = performance.now();
          setTimeout(() => {
            resolve(performance.now() - start);
          }, 0);
        }),
    );
    expect(answered).toBeLessThan(500);

    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
      undefined,
    );
    // Markup is displayed as the characters it is made of.
    await expect(
      page.getByText('<script>window.__pwned = "script"</script>', { exact: false }),
    ).toBeVisible();
    // No element made from the payloads: no script, frame or svg inside the feed, no inline handler.
    const injected = await page.evaluate(() => {
      const feed = document.querySelector('[role=feed]');
      return {
        elements:
          feed?.querySelectorAll('script, iframe, svg[onload], img[onerror], object, embed')
            .length ?? -1,
        handlers: feed?.querySelectorAll('[onerror], [onload], [onclick]').length ?? -1,
        scripts: [...(feed?.querySelectorAll('a[href]') ?? [])]
          .map((a) => a.getAttribute('href') ?? '')
          .filter((href) => /^\s*(javascript|data|vbscript):/i.test(href)),
      };
    });
    expect(injected).toEqual({ elements: 0, handlers: 0, scripts: [] });

    // Clicking what looks like a link does nothing dangerous either.
    const lookalike = page.getByText('click me', { exact: false }).first();
    await lookalike.click({ trial: false }).catch(() => undefined);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
      undefined,
    );

    const wide = await page.evaluate(() =>
      [...document.querySelectorAll('[data-message-row]')]
        .map((row, index) => ({
          index,
          over: row.scrollWidth - row.clientWidth,
          text: row.textContent.slice(0, 30),
        }))
        .filter((row) => row.over > 1),
    );
    expect(wide, 'rows wider than their box').toEqual([]);
    const sideways = await sidewaysScroll(page);
    expect(sideways.feed).toBeLessThanOrEqual(1);
    expect(sideways.document).toBeLessThanOrEqual(1);
    // Every row stays inside the feed's width.
    const overflowing = await page.evaluate(() => {
      const feed = document.querySelector('[role=feed]');
      if (feed === null) return -1;
      const limit = feed.getBoundingClientRect().right + 1;
      return [...feed.querySelectorAll('[data-message-row]')].filter(
        (row) => row.getBoundingClientRect().right > limit,
      ).length;
    });
    expect(overflowing).toBe(0);
  });

  test('the deepest bodies the bounds allow are formatted in a browser, and one past each is shown as typed (D-101 §5)', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    test.setTimeout(120_000);
    // Each level an item of the one above; only the innermost says which body it is, in bold.
    const nestedList = (levels: number, mark: string): string =>
      Array.from({ length: levels }, (_, level) =>
        level === levels - 1 ? `${'  '.repeat(level)}- **${mark}**` : `${'  '.repeat(level)}- x`,
      ).join('\n');
    // Where the depth bound falls is `readMarkdown`'s to say; found here, never copied.
    let levels = 1;
    while (
      readMarkdown(nestedList(levels, 'depth-at')).tree !== null &&
      levels < MESSAGE_CONTENT_MAX
    )
      levels += 1;
    expect(readMarkdown(nestedList(levels, 'depth-at'))).toEqual({ tree: null, reason: 'depth' });
    const bodies: readonly { readonly mark: string; readonly at: string; readonly past: string }[] =
      [
        {
          mark: 'nesting',
          at: `${'> '.repeat(MARKDOWN_NESTING_MAX)}**nesting-at**`,
          past: `${'> '.repeat(MARKDOWN_NESTING_MAX + 1)}**nesting-past**`,
        },
        {
          mark: 'delimiters',
          at: `**delimiters-at** ${'*'.repeat(MARKDOWN_DELIMITERS_MAX - 4)}`,
          past: `**delimiters-past** ${'*'.repeat(MARKDOWN_DELIMITERS_MAX - 3)}`,
        },
        {
          mark: 'run',
          at: `**run-at** ${'a'.repeat(MARKDOWN_RUN_MAX)}`,
          past: `**run-past** ${'a'.repeat(MARKDOWN_RUN_MAX + 1)}`,
        },
        {
          mark: 'depth',
          at: nestedList(levels - 1, 'depth-at'),
          past: nestedList(levels, 'depth-past'),
        },
      ];
    const wideTable = `| ${Array.from({ length: 40 }, (_, i) => `column ${String(i)}`).join(' | ')} |\n|${' - |'.repeat(40)}\n| ${'cell | '.repeat(40)}`;

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    const made = await room({ members: ['dogancan', 'alice'] });
    for (const body of bodies) {
      await api('carol').say(made.id, body.at);
      await api('carol').say(made.id, body.past);
    }
    await api('carol').say(made.id, wideTable);
    await signIn();
    await page.goto(made.path);
    await expect(page.locator('[data-message-row]')).toHaveCount(bodies.length * 2 + 1);

    for (const body of bodies) {
      // At the bound: formatted, so the words are bold and the asterisks are gone.
      await expect(
        page.locator('[data-message-body] strong', { hasText: `${body.mark}-at` }),
      ).toHaveCount(1);
      // One past: the characters as they were sent, asterisks and all, and nothing bold.
      await expect(
        page.locator('[data-message-body] strong', { hasText: `${body.mark}-past` }),
      ).toHaveCount(0);
      await expect(page.getByText(`**${body.mark}-past**`, { exact: false })).toHaveCount(1);
      // And for the reason the bound names, not some other failure.
      await expect(page.locator(`[data-as-typed="${body.mark}"]`)).toHaveCount(1);
    }
    await expect(page.getByRole('group', { name: 'Table' })).toBeVisible();

    expect(errors, 'errors in the page').toEqual([]);
    const sideways = await sidewaysScroll(page);
    expect(sideways.feed).toBeLessThanOrEqual(1);
    expect(sideways.document).toBeLessThanOrEqual(1);
  });

  test('inside a thread, the same', async ({ page, signIn, room, api }) => {
    test.setTimeout(90_000);
    const made = await room({ members: ['dogancan', 'alice'] });
    const root = await api('carol').say(made.id, 'a root for hostile replies');
    for (const payload of PAYLOADS.slice(0, 9)) {
      await api('carol').say(made.id, payload.text, { parentId: root.id });
    }
    await signIn();
    await page.goto(`${made.path}?thread=${root.id}`);
    const thread = page.locator(`[data-thread-root="${root.id}"]`);
    await expect(thread).toBeVisible();
    await expect(thread.locator('[data-message-row]')).toHaveCount(9);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
      undefined,
    );
    expect((await sidewaysScroll(page)).feed).toBeLessThanOrEqual(1);
  });

  test('typed into the composer, a character the server cannot take is refused with words, and the rest goes', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.goto(made.path);
    const box = page.getByRole('textbox', { name: /^Message/ });
    // `fill` would normalise the lone surrogate on its way in; the field is set as a script would.
    await box.evaluate((field: HTMLTextAreaElement) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      ) as {
        set: (this: HTMLTextAreaElement, value: string) => void;
      };
      descriptor.set.call(field, 'a lone surrogate \uD800 in the middle');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await box.press('Enter');
    await expect(page.getByText(/character Purlay cannot send/).first()).toBeVisible();
    const held = await api('dogancan').get<{ data: unknown[] }>(
      `/api/channels/${made.id}/messages?limit=5`,
    );
    expect(held.data).toHaveLength(0);

    await box.fill('<script>window.__pwned=1</script> typed by a person');
    await box.press('Enter');
    await expect(page.getByText('typed by a person')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBe(
      undefined,
    );
  });
});
