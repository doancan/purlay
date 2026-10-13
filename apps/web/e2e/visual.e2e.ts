/**
 * The populated screens, photographed (D-53: every screen in both themes; `UX.md` §2: at two
 * widths — the four projects). Empty, loading and error states are photographed where they are
 * specified (`states`); these are the ones that need a conversation in them.
 *
 * Each test builds a room of its own with fixed words, so the picture is the same on every run;
 * what is not fixed — the room's name, which is unique, and the times, which are "now" — is
 * masked. Only the conversation (the `main` region) is photographed: the sidebar lists every
 * room every test has made, and is the shell's business (`frame`).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { shellReady } from './support';

const RICH = [
  'Plain words with a **bold** claim, then a link: https://example.com/a/path.',
  'Inline `code`, a mention of @alice and @bob, and a token: ' + 'x'.repeat(90),
  '```ts\nconst answer: number = 42;\nconsole.log(`the answer is ${answer}`);\n```',
  'Two lines\nand a third line',
  // A quotation and a mention of the reader, side by side: they once looked alike (D-119 §5, amended).
  '> quoted from the runbook\n\n@dogancan this one is yours, and @alice can help.',
];

// Only what is on screen: a thread panel on a narrow window covers the channel, and a mask drawn
// over what is under it would paint over the panel instead (D-122).
const masks = (page: Page): Locator[] => [
  page.locator('time:visible'),
  // The title and the topic beside it: a test's room has a name of its own length, and the group
  // takes the header's room whatever it is, so the mask is one size every run.
  page.locator('[data-header-title]:visible'),
  // The thread panel names the room too.
  page.locator('[data-thread-root] h2'),
  page.getByRole('textbox'),
  page.locator('[data-feed-marker]:visible'),
  // The workspace-wide count of open questions moves with every other test.
  page.getByRole('link', { name: /^Open questions/ }),
];

const ready = async (page: Page): Promise<void> => {
  await shellReady(page);
  // The first row that is on screen: under a thread panel on a narrow window, that is the panel's root.
  await expect(page.locator('[data-message-row]:visible').first()).toBeVisible();
  // Fonts and layout settled: the pictures must not catch a reflow.
  await page.evaluate(() => document.fonts.ready);
};

const snap = async (page: Page, name: string): Promise<void> => {
  await expect(page.locator('main')).toHaveScreenshot(name, { mask: masks(page) });
};

test.describe('a conversation', () => {
  test('with every kind of content, reactions, and the marker where reading begins', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice', 'bob'] });
    const first = await api('alice').say(made.id, RICH[0] ?? '');
    for (const text of RICH.slice(1)) await api('bob').say(made.id, text);
    await api('alice').react(first.id, '🚀');
    await api('bob').react(first.id, '🚀');
    await api('bob').react(first.id, '👀');
    await signIn();
    await page.goto(made.path);
    await ready(page);
    await snap(page, 'conversation.png');
  });

  test('with a thread closed, one open in the panel, and one resolved', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'alice', 'bob'] });
    const collapsed = await api('alice').say(made.id, 'a question that is still open?');
    await api('bob').say(made.id, 'a first answer', { parentId: collapsed.id });
    const resolved = await api('alice').say(made.id, 'a question that was settled?');
    await api('bob').say(made.id, 'yes, settled', { parentId: resolved.id });
    await api('alice').resolve(resolved.id);
    const open = await api('bob').say(made.id, 'a question being read right now?');
    await api('alice').say(made.id, 'the answer, in words', { parentId: open.id });
    await api('bob').say(made.id, 'and a follow-up', { parentId: open.id });
    await signIn();
    await page.goto(`${made.path}?thread=${open.id}`);
    await ready(page);
    const panel = page.locator(`[data-thread-root="${open.id}"]`);
    await expect(panel).toBeVisible();
    // The panel's replies drawn, not its skeleton (D-122).
    await expect(panel.getByText('and a follow-up')).toBeVisible();
    // A linked thread takes focus in its heading. Whether the browser draws a ring for focus moved
    // by a script depends on what it saw before, so the picture is taken with focus let go: rings
    // are focus.e2e.ts's to check, every one of them.
    await expect(panel.getByRole('heading', { level: 2 })).toBeFocused();
    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await snap(page, 'threads.png');
  });

  test('with a failed send and a refused draft', async ({ page, signIn, room }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.routeWebSocket(/\/ws$/, (route) => {
      route.connectToServer();
      route.onMessage(() => undefined);
    });
    await page.goto(made.path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const box = page.getByRole('textbox', { name: /^Message/ });
    await box.fill('this one will not get an answer');
    await box.press('Enter');
    await expect(page.getByText('Failed to send', { exact: true })).toBeVisible();
    await box.fill('@here please look');
    await box.press('Enter');
    await expect(page.getByText(/is not available/).first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('main')).toHaveScreenshot('failed-and-refused.png', {
      mask: [page.locator('time'), page.locator('[data-header-title]'), page.getByRole('textbox')],
    });
  });
});

test.describe('the overlays over a conversation', () => {
  test('the shortcuts reference', async ({ page, signIn, room, api }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await api('alice').say(made.id, 'something behind the dialog');
    await signIn();
    await page.goto(made.path);
    await ready(page);
    await page.keyboard.press('ControlOrMeta+/');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveScreenshot('shortcuts.png');
  });
});
