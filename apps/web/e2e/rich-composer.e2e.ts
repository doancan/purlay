/** The default formatted editor uses real browser editing, selection, undo and IME events. */
import { expect, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';

test.use({ sourceEditor: false });

const rich = (page: Page): Locator => page.locator('[contenteditable="true"][data-composer]');
const source = (page: Page): Locator => page.locator('textarea[data-composer]');
const mode = (page: Page): Locator =>
  page.getByRole('button', { name: 'Markdown source', exact: true });

test('formatted text is editable by default; Markdown exposes the source and returns to editing', async ({
  page,
  signIn,
  room,
  api,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await expect(rich(page)).toBeVisible();
  await expect(mode(page)).toHaveAttribute('aria-pressed', 'false');
  await rich(page).fill('');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await rich(page).pressSequentially('Bold');
  await expect(rich(page).locator('strong')).toHaveText('Bold');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await rich(page).pressSequentially(' normal');
  await expect(rich(page).locator('strong')).toHaveText('Bold');
  await mode(page).click();
  await expect(source(page)).toBeFocused();
  await expect(source(page)).toHaveValue('**Bold** normal');
  await mode(page).click();
  await expect(rich(page)).toBeFocused();
  await rich(page).press('Enter');
  await expect(rich(page)).toBeEmpty();
  await expect
    .poll(async () =>
      (
        await api('dogancan').get<{ data: { content: string }[] }>(
          `/api/channels/${made.id}/messages`,
        )
      ).data.map((item) => item.content),
    )
    .toContain('**Bold** normal');
});

test('source switches preserve noncanonical Markdown and selection without editing the draft', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await mode(page).click();
  await source(page).fill('__bold__ + *italic*');
  await source(page).evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(3, 3);
  });
  await mode(page).click();
  await expect(rich(page).locator('strong')).toHaveText('bold');
  await mode(page).click();
  await expect(source(page)).toHaveValue('__bold__ + *italic*');
  expect(
    await source(page).evaluate((element: HTMLTextAreaElement) => element.selectionStart),
  ).toBe(3);
});

test('Markdown typing formats immediately, with native undo and formatting state for mixed selections', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await rich(page).pressSequentially('**bold**');
  await expect(rich(page).locator('strong')).toHaveText('bold');
  await rich(page).pressSequentially(' plain');
  await rich(page).press('ControlOrMeta+a');
  await expect(page.getByRole('button', { name: 'Bold', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Italic', exact: true }).click();
  await expect(rich(page).locator('em')).toHaveText(['bold', ' plain']);
  await rich(page).press('ControlOrMeta+z');
  await expect(rich(page).locator('em')).toHaveCount(0);
  await mode(page).click();
  await mode(page).click();
  await rich(page).press('ControlOrMeta+Shift+z');
  await expect(rich(page).locator('em')).toHaveText(['bold', ' plain']);
});

test('lists convert type, continue with Shift+Enter and allow keyboard task checking', async ({
  page,
  signIn,
  room,
  expectNoAxe,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await page.getByRole('button', { name: 'Bulleted list', exact: true }).click();
  await rich(page).pressSequentially('one');
  await rich(page).press('Shift+Enter');
  await rich(page).pressSequentially('two');
  await expect(rich(page).locator('li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Numbered list', exact: true }).click();
  await expect(rich(page).locator('ol')).toHaveCount(1);
  await page.getByRole('button', { name: 'Task list', exact: true }).click();
  const check = rich(page).getByRole('checkbox').first();
  await check.click();
  await expect(check).toHaveAttribute('aria-checked', 'true');
  await check.focus();
  await check.press('Space');
  await expect(check).toHaveAttribute('aria-checked', 'false');
  await expectNoAxe(page.locator('[data-composer-card]'));
  await mode(page).click();
  await source(page).fill('one\n\ntwo');
  await mode(page).click();
  await rich(page).press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Task list', exact: true }).click();
  await expect(rich(page).getByRole('checkbox')).toHaveCount(2);
});

test('code keeps Enter as a newline, Shift+Enter remains inside code and Mod+Enter sends', async ({
  page,
  signIn,
  room,
  api,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await page.getByRole('button', { name: 'Code block', exact: true }).click();
  await rich(page).pressSequentially('first');
  await rich(page).press('Enter');
  await rich(page).pressSequentially('second');
  await rich(page).press('Shift+Enter');
  await rich(page).pressSequentially('third');
  await expect(rich(page).locator('pre code')).toHaveText('first\nsecond\nthird');
  await rich(page).press('ControlOrMeta+Enter');
  await expect
    .poll(async () =>
      (
        await api('dogancan').get<{ data: { content: string }[] }>(
          `/api/channels/${made.id}/messages`,
        )
      ).data.map((item) => item.content),
    )
    .toContain('```\nfirst\nsecond\nthird\n```');
});

test('link details insert a safe editable link at the selected words', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await rich(page).fill('release notes');
  await rich(page).press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(page.getByLabel('Display text')).toHaveValue('release notes');
  await page.getByLabel('Link address').fill('https://example.com/releases');
  await page.getByRole('button', { name: 'Insert link', exact: true }).click();
  await expect(rich(page).getByRole('link')).toHaveText('release notes');
  await expect(rich(page).getByRole('link')).toHaveAttribute(
    'href',
    'https://example.com/releases',
  );
});

test('emoji conversion has Backspace undo and code stays literal', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await rich(page).pressSequentially(':) ');
  await expect(rich(page)).toHaveText('🙂 ');
  await rich(page).press('Backspace');
  await expect(rich(page)).toHaveText(':) ');
  await rich(page).press('ControlOrMeta+a');
  await rich(page).press('Backspace');
  await page.getByRole('button', { name: 'Code block', exact: true }).click();
  await rich(page).pressSequentially(':) ');
  await expect(rich(page).locator('code')).toHaveText(':) ');
});

test('IME candidate Enter never sends; a later Enter does', async ({ page, signIn, room, api }) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await rich(page).fill('日本語');
  await rich(page).dispatchEvent('compositionstart', { data: '' });
  await rich(page).press('Enter');
  expect(
    (await api('dogancan').get<{ data: unknown[] }>(`/api/channels/${made.id}/messages`)).data,
  ).toHaveLength(0);
  await rich(page).dispatchEvent('compositionend', { data: '日本語' });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await rich(page).press('Enter');
  await expect
    .poll(async () =>
      (
        await api('dogancan').get<{ data: { content: string }[] }>(
          `/api/channels/${made.id}/messages`,
        )
      ).data.map((item) => item.content),
    )
    .toContain('日本語');
});

test('long formatted drafts fit a narrow screen and remain accessible', async ({
  page,
  signIn,
  room,
  expectNoAxe,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await page.setViewportSize({ width: 390, height: 844 });
  await rich(page).fill('A long update for İstanbul. '.repeat(60));
  const host = rich(page).locator('..');
  expect(await host.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  expect(
    await host.evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(844 * 0.4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expectNoAxe(page.locator('[data-composer-card]'));
});

test('source mode preserves whether the caret is inside or outside bold', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await rich(page).pressSequentially('word');
  await mode(page).click();
  await source(page).pressSequentially('X');
  await expect(source(page)).toHaveValue('**wordX**');
  await mode(page).click();
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await mode(page).click();
  await source(page).pressSequentially('Y');
  await expect(source(page)).toHaveValue('**wordX**Y');
});

test('formatted paste and table editing stay within the supported message grammar', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await rich(page).focus();
  await rich(page).evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/plain', 'Bold and italic');
    data.setData('text/html', '<p><strong>Bold</strong> and <em>italic</em></p>');
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(rich(page).locator('strong')).toHaveText('Bold');
  await expect(rich(page).locator('em')).toHaveText('italic');
  await rich(page).press('ControlOrMeta+a');
  await rich(page).press('Backspace');
  await page.getByRole('button', { name: 'Table', exact: true }).click();
  const cell = rich(page).locator('th').first();
  await cell.click();
  await rich(page).press('Shift+Enter');
  await rich(page).pressSequentially('after the table');
  await expect(rich(page).locator(':scope > p').last()).toHaveText('after the table');
  await mode(page).click();
  await expect(source(page)).toHaveValue(/\|.*\|[\s\S]*\n\nafter the table$/);
});

test('a face converts on a newline, Backspace restores it, and send converts a closing face', async ({
  page,
  signIn,
  room,
  api,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await rich(page).pressSequentially(':)');
  await rich(page).press('Shift+Enter');
  await expect(rich(page)).toContainText('🙂');
  await rich(page).press('Backspace');
  await expect(rich(page)).toContainText(':)');
  await rich(page).press('ControlOrMeta+a');
  await rich(page).press('Backspace');
  await rich(page).pressSequentially(':D');
  await rich(page).press('Enter');
  await expect
    .poll(async () =>
      (
        await api('dogancan').get<{ data: { content: string }[] }>(
          `/api/channels/${made.id}/messages`,
        )
      ).data.map((item) => item.content),
    )
    .toContain('😄');
});

test('mentions still complete, saved drafts survive reload, and slash commands still run', async ({
  page,
  signIn,
  room,
  api,
}) => {
  const made = await room({ members: ['dogancan', 'alice'] });
  await signIn();
  await page.goto(made.path);
  await rich(page).pressSequentially('@ali');
  await expect(page.getByRole('listbox', { name: 'People' })).toBeVisible();
  await rich(page).press('Tab');
  await expect(rich(page)).toHaveText('@alice ');
  await expect
    .poll(
      async () =>
        await page.evaluate((channelId) => {
          const key = Object.keys(localStorage).find(
            (item) => item.startsWith('purlay.draft.') && item.includes(channelId),
          );
          return key === undefined ? null : localStorage.getItem(key);
        }, made.id),
    )
    .toBe('@alice ');
  await page.reload();
  await expect(rich(page)).toHaveText('@alice ');
  await rich(page).press('ControlOrMeta+a');
  await rich(page).press('Backspace');
  await rich(page).pressSequentially('/shrug yep');
  await rich(page).press('Enter');
  await expect
    .poll(async () =>
      (
        await api('dogancan').get<{ data: { content: string }[] }>(
          `/api/channels/${made.id}/messages`,
        )
      ).data.map((item) => item.content),
    )
    .toContain('yep ¯\\\\\\_(ツ)\\_/¯');
});
