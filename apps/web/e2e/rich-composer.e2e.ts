/** The default formatted editor uses real browser editing, selection, undo and IME events. */
import { expect, test } from './fixtures';
import type { Locator, Page } from '@playwright/test';

test.use({ sourceEditor: false });

const rich = (page: Page): Locator => page.locator('[contenteditable="true"][data-composer]');
const source = (page: Page): Locator => page.locator('textarea[data-composer]');
const mode = (page: Page): Locator =>
  page.getByRole('button', { name: 'Markdown source', exact: true });

test('immediate reload keeps the most recent formatted draft', async ({ page, signIn, room }) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await rich(page).pressSequentially('saved immediately');
  await page.reload();
  await expect(rich(page).locator('strong')).toHaveText('saved immediately');
});

test('a storage failure is explained, retry saves, and typing remains available', async ({
  page,
  signIn,
  room,
  expectNoAxe,
}) => {
  await page.addInitScript(() => {
    const save: unknown = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')?.value;
    if (typeof save !== 'function') throw new Error('Storage.setItem is unavailable');
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key.startsWith('purlay.draft.') && sessionStorage.getItem('allow-draft-save') !== 'yes')
        throw new DOMException('Quota', 'QuotaExceededError');
      Reflect.apply(save, this, [key, value]);
    };
  });
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await rich(page).fill('keep these words');
  await expect(page.getByText(/Draft could not be saved/)).toBeVisible();
  await expect(rich(page)).toHaveText('keep these words');
  await expectNoAxe(page.locator('main'));
  await page.evaluate(() => {
    sessionStorage.setItem('allow-draft-save', 'yes');
  });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText(/Draft could not be saved/)).toHaveCount(0);
  await expect(rich(page)).toBeFocused();
  await page.reload();
  await expect(rich(page)).toHaveText('keep these words');
});

test('clear formatting is one undoable action and preserves the text', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await mode(page).click();
  await source(page).fill('> - **one**\n> - _two_');
  await mode(page).click();
  await rich(page).press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Clear formatting', exact: true }).click();
  await expect(rich(page).locator('strong,em,ul,ol,blockquote')).toHaveCount(0);
  await expect(rich(page).locator('p')).toHaveText(['one', 'two']);
  await rich(page).press('ControlOrMeta+z');
  await expect(rich(page).locator('blockquote ul')).toHaveCount(1);
});

test('clear formatting also works from Markdown source', async ({ page, signIn, room }) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await mode(page).click();
  await source(page).fill('**bold** and _italic_');
  await source(page).press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Clear formatting', exact: true }).click();
  await expect(source(page)).toHaveValue('bold and italic');
  await expect(source(page)).toBeFocused();
});

test('clearing multiline code preserves blank lines and indentation after reload', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await mode(page).click();
  await source(page).fill('```\n\n  one\n\n    two\n\n```');
  await mode(page).click();
  await rich(page).press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Clear formatting', exact: true }).click();
  await expect(rich(page).locator('pre')).toHaveCount(0);
  expect(await rich(page).textContent()).toBe('  one    two');
  expect(await rich(page).locator('br').count()).toBeGreaterThanOrEqual(4);
  await expect(rich(page)).toHaveAttribute('data-empty', 'false');
  await page.reload();
  expect(await rich(page).textContent()).toBe('  one    two');
  expect(await rich(page).locator('br').count()).toBeGreaterThanOrEqual(4);
});

test('existing links can be safely edited and removed from source mode', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await mode(page).click();
  await source(page).fill('Before [**notes**](https://example.com/old) after');
  await source(page).evaluate((element: HTMLTextAreaElement) => {
    element.setSelectionRange(12, 12);
  });
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit link' });
  await expect(dialog.getByLabel('Link address')).toHaveValue('https://example.com/old');
  await dialog.getByLabel('Link address').fill('javascript:alert(1)');
  await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('Link address').fill('https://example.com/new');
  await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(source(page)).toHaveValue(
    /Before \[\*\*notes\*\*\]\(<https:\/\/example.com\/new>\) after/,
  );
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByRole('button', { name: 'Remove link', exact: true }).click();
  await expect(source(page)).toHaveValue('Before **notes** after');
});

test('blank formatted lines stay editable but cannot send an empty message', async ({
  page,
  signIn,
  room,
  api,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await rich(page).press('Shift+Enter');
  await rich(page).press('Shift+Enter');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await rich(page).press('Enter');
  expect(
    (await api('dogancan').get<{ data: unknown[] }>(`/api/channels/${made.id}/messages`)).data,
  ).toHaveLength(0);
});

test('existing links prefill their address, keep styled labels, and can be removed', async ({
  page,
  signIn,
  room,
  expectNoAxe,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await mode(page).click();
  await source(page).fill('[  **release** notes  ](https://example.com/old)');
  await mode(page).click();
  await rich(page).getByRole('link').filter({ hasText: 'release' }).first().click();
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit link' });
  await expect(dialog.getByLabel('Display text')).toHaveValue('  release notes  ');
  await expect(dialog.getByLabel('Link address')).toHaveValue('https://example.com/old');
  await expectNoAxe(dialog);
  await dialog.getByLabel('Link address').fill('https://example.com/new');
  await dialog.getByRole('button', { name: 'Save link', exact: true }).click();
  await expect(rich(page).getByRole('link').first()).toHaveAttribute(
    'href',
    'https://example.com/new',
  );
  await expect(rich(page).locator('a[href="https://example.com/old"]')).toHaveCount(0);
  await expect(rich(page).locator('strong')).toHaveText('release');
  expect(await rich(page).textContent()).toBe('  release notes  ');
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByRole('button', { name: 'Remove link', exact: true }).click();
  await expect(rich(page).getByRole('link')).toHaveCount(0);
  await expect(rich(page)).toHaveText('release notes');
  await expect(rich(page).locator('strong')).toHaveText('release');
});

test('unlinking an address stays unlinked after a mode switch and reload', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await mode(page).click();
  await source(page).fill('[https://example.com](https://example.com)');
  await mode(page).click();
  await rich(page).getByRole('link').click();
  await page.getByRole('button', { name: 'Link', exact: true }).click();
  await page.getByRole('button', { name: 'Remove link', exact: true }).click();
  await expect(rich(page).getByRole('link')).toHaveCount(0);
  await expect(rich(page)).toHaveText('https://example.com');
  await mode(page).click();
  await mode(page).click();
  await page.reload();
  await expect(rich(page).getByRole('link')).toHaveCount(0);
  await expect(rich(page)).toHaveText('https://example.com');
});

test('code has an explicit way back to normal writing, with its content preserved', async ({
  page,
  signIn,
  room,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await page.getByRole('button', { name: 'Code block', exact: true }).click();
  await rich(page).pressSequentially('const answer = 42;');
  await rich(page).press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Continue in a normal paragraph', exact: true }).click();
  await expect(rich(page)).toBeFocused();
  await rich(page).pressSequentially('explanation');
  await expect(rich(page).locator('pre code')).toHaveText('const answer = 42;');
  await expect(rich(page).locator(':scope > p')).toHaveText('explanation');
});

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
