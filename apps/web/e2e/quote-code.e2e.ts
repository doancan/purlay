/** Quotes and code survive the toolbar, native clipboard, preview, send and edit. */
import { expect, test } from './fixtures';

test('quote formatting keeps a list and its blank lines together through preview and send', async ({
  page,
  signIn,
  room,
  expectNoAxe,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  const box = page.getByRole('textbox', { name: `Message ${made.name}` });
  const source = '- first item\n\n- second item\n> original quote';
  await box.fill(source);
  await box.press('ControlOrMeta+A');
  await page.getByRole('button', { name: 'Quote', exact: true }).click();
  const quoted = '> - first item\n> \n> - second item\n> > original quote';
  await expect(box).toHaveValue(quoted);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = page.locator('[data-composer-preview]');
  await expect(preview.locator('blockquote').first().locator('li')).toHaveCount(2);
  await expectNoAxe(preview);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(box).toHaveValue(quoted);
  await box.press('ControlOrMeta+Enter');
  await expect(page.locator('[data-message-row] blockquote').first().locator('li')).toHaveCount(2);
});

test('native paste stays inside tilde code and Enter also continues code in an edit and a thread', async ({
  page,
  context,
  signIn,
  room,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const made = await room();
  await signIn();
  await page.goto(made.path);
  const box = page.getByRole('textbox', { name: `Message ${made.name}` });
  const code = Array.from({ length: 13 }, (_, i) => `const value${String(i)} = ${String(i)};`).join(
    '\n',
  );
  await box.fill('~~~ts\n');
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
  }, code);
  await box.press('ControlOrMeta+V');
  await expect(box).toHaveValue(`~~~ts\n${code}`);
  await box.press('Enter');
  await expect(box).toHaveValue(`~~~ts\n${code}\n`);
  await box.pressSequentially('~~~');
  await box.press('Enter');
  await expect(box).toHaveValue('');
  const row = page.locator('[data-message-row]', { hasText: 'const value0' });
  await expect(row.locator('figure')).toHaveCount(1);
  await row.getByRole('button', { name: 'Copy code', exact: true }).click();
  expect(await page.evaluate(async () => await navigator.clipboard.readText())).toBe(code);
  await row.focus();
  await page.keyboard.press('e');
  const editor = page.getByRole('textbox', { name: 'Edit your message' });
  await editor.fill('````md\n```ts');
  await editor.press('Enter');
  await expect(editor).toHaveValue('````md\n```ts\n');
  await editor.press('Escape');
  await row.focus();
  await page.keyboard.press('r');
  const reply = page.locator('[data-thread-root]').getByRole('textbox');
  await reply.fill('~~~ts');
  await reply.press('Enter');
  await expect(reply).toHaveValue('~~~ts\n');
});

test('a quoted code block keeps copy and wrap reachable at 320 pixels, including long language names', async ({
  page,
  context,
  signIn,
  room,
  expectNoAxe,
}, info) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const language = 'unsupported-language-with-a-very-long-name';
  const code = `const address = "${'long-address-'.repeat(20)}";\n  keepIndent();\n\n`;
  const quoted = `> \`\`\`${language}\n${code
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')}\n> \`\`\``;
  const made = await room({ messages: [{ by: 'dogancan', text: quoted }] });
  await signIn();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(made.path);
  const figure = page.locator('[data-message-row] figure');
  await expect(figure).toBeVisible();
  const copy = figure.getByRole('button', { name: 'Copy code', exact: true });
  const bounds = await copy.boundingBox();
  expect(bounds).not.toBeNull();
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(320);
  await figure.getByRole('button', { name: 'Wrap lines', exact: true }).click();
  await copy.click();
  expect(await page.evaluate(async () => await navigator.clipboard.readText())).toBe(code);
  await figure.locator('pre').focus();
  await expect(figure.locator('pre')).toBeFocused();
  expect(await figure.evaluate((element) => element.scrollLeft)).toBe(0);
  const caption = figure.locator('figcaption');
  expect(await caption.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await expectNoAxe(figure);
  await page.screenshot({ path: info.outputPath('quote-code-320.png') });
});
