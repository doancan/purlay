/**
 * The accessibility audit (axe, WCAG 2.0/2.1 A and AA, colour contrast included) of the screens
 * and states that only exist once there is something in them: a feed with every kind of content,
 * threads open, collapsed and resolved, a failed send, a refusal, the open questions with entries,
 * the overlays. The empty, loading and error states, the frame, the palette, the create dialog
 * and menus are audited where they are specified (`states`, `frame`, `polish`). Each project is a
 * theme and a width, so every state here is audited in both themes.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

const RICH = [
  'Plain words with a **bold** claim and a link to https://example.com/a/very/long/path?with=query.',
  'Inline `code` and a mention of @alice and @bob, and a long unbroken token ' + 'x'.repeat(120),
  '```ts\nconst answer: number = 42;\nconsole.log(`the answer is ${answer}`);\n```',
  'A line\nand another line\n\nand a paragraph after a blank one',
];

const ready = async (page: Page): Promise<void> => {
  await expect(page.getByRole('complementary')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
};

test.describe('a populated channel', () => {
  test('with every kind of content in its feed, reactions, and an unread marker', async ({
    page,
    signIn,
    room,
    api,
    expectNoAxe,
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
    await expect(page.locator('pre')).toBeVisible();
    await expect(page.locator('[data-feed-marker]')).toBeVisible();
    await expectNoAxe();
  });

  test('with a thread collapsed, open, and resolved', async ({
    page,
    signIn,
    room,
    api,
    expectNoAxe,
  }) => {
    const made = await room({ members: ['dogancan', 'alice', 'bob'] });
    const open = await api('alice').say(made.id, 'a question that stays open?');
    await api('bob').say(made.id, 'an answer', { parentId: open.id });
    const closed = await api('alice').say(made.id, 'a question that was settled?');
    await api('bob').say(made.id, 'yes', { parentId: closed.id });
    await api('alice').resolve(closed.id);
    await signIn();
    await page.goto(made.path);
    await ready(page);
    await expect(page.getByRole('button', { name: /Open · 1 reply/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Resolved by alice/ })).toBeVisible();
    await expectNoAxe();

    await page.getByRole('button', { name: /Open · 1 reply/ }).click();
    await expect(page.locator(`[data-thread-root="${open.id}"]`)).toBeVisible();
    await expectNoAxe();
  });

  test('with a message that failed to send, and a draft that was refused', async ({
    page,
    signIn,
    room,
    expectNoAxe,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    await signIn();
    await page.routeWebSocket(/\/ws$/, (route) => {
      route.connectToServer();
      route.onMessage(() => undefined);
    });
    await page.goto(made.path);
    await ready(page);
    const box = page.getByRole('textbox', { name: /^Message/ });
    await box.fill('this one will not get an answer');
    await box.press('Enter');
    await expect(page.getByText('Failed to send', { exact: true })).toBeVisible();
    await expectNoAxe();

    await box.fill('@here nobody is notified of everybody');
    await box.press('Enter');
    await expect(page.getByText(/is not available/).first()).toBeVisible();
    await expectNoAxe();
  });

  test('scrolled up, with the pill that says how much is waiting', async ({
    page,
    signIn,
    room,
    api,
    expectNoAxe,
  }) => {
    test.setTimeout(90_000);
    const made = await room({ members: ['dogancan', 'alice'] });
    for (let index = 0; index < 40; index++)
      await api('alice').say(made.id, `line ${String(index)}`);
    await signIn();
    await page.goto(made.path);
    await ready(page);
    await page
      .getByRole('feed')
      .locator('..')
      .evaluate((el) => {
        el.scrollTop = 0;
      });
    await api('alice').say(made.id, 'arrives while reading up');
    await expect(page.getByRole('button', { name: /new message/ })).toBeVisible();
    await expectNoAxe();
  });
});

test.describe('the other screens', () => {
  test('the open questions, with entries in several channels', async ({
    page,
    signIn,
    room,
    api,
    expectNoAxe,
  }) => {
    const made = await room({ members: ['dogancan', 'alice', 'bob'] });
    const root = await api('alice').say(made.id, 'is this audited?');
    await api('bob').say(made.id, 'yes', { parentId: root.id });
    await signIn();
    await page.goto('/w/acme-eng/questions');
    await ready(page);
    await expect(page.getByText('is this audited?').first()).toBeVisible();
    await expectNoAxe();
  });

  test('the shortcuts reference, and the reply box of an open thread', async ({
    page,
    signIn,
    room,
    api,
    expectNoAxe,
  }) => {
    const made = await room({ members: ['dogancan', 'alice'] });
    const root = await api('alice').say(made.id, 'can I reply here?');
    await api('alice').say(made.id, 'you can', { parentId: root.id });
    await signIn();
    await page.goto(`${made.path}?thread=${root.id}`);
    await ready(page);
    await expect(page.locator(`[data-thread-root="${root.id}"]`)).toBeVisible();
    await expectNoAxe();
    await page.keyboard.press('ControlOrMeta+/');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expectNoAxe();
  });
});
