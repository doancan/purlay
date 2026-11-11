/** The real workspace catalogue: upload, visible/private source authority, live edits and a thread reply. */
import { expect, test } from './fixtures';
import { railLink, shellReady } from './support';

test('Shared finds files and links in conversations and follows their live source', async ({
  page,
  signIn,
  room,
  tenant,
  api,
  expectNoAxe,
}, info) => {
  const made = await room({ members: ['dogancan', 'carol'] });
  const root = await api('carol').say(made.id, 'Which purchasing policy applies?');
  const title = `${made.name} policy`;
  const reply = await api('carol').say(
    made.id,
    `[${title}](http://intranet/purchasing?room=${made.name})`,
    { parentId: root.id },
  );
  const hidden = await api('carol').post<{ id: string }>(
    `/api/workspaces/${tenant.workspaceId}/channels`,
    { name: `${made.name}-private`, type: 'private' },
  );
  await api('carol').say(
    hidden.id,
    `[${made.name} confidential](https://secret.example/${made.name})`,
  );
  await signIn();
  await page.goto(made.path);
  const composer = page.getByRole('textbox', { name: `Message ${made.name}` });
  await expect(composer).toBeVisible();
  const filename = `${made.name}-handover.txt`;
  await page.locator('input[type="file"]').setInputFiles({
    name: filename,
    mimeType: 'text/plain',
    buffer: Buffer.from('Purchasing contacts and handover notes'),
  });
  await expect(page.getByRole('list', { name: 'Files' }).getByText(/Uploading/)).toHaveCount(0);
  await composer.fill('Supplier handover');
  await composer.press('Enter');
  await expect(
    page
      .locator('[data-message-row]')
      .getByRole('link', { name: new RegExp(`Download ${filename}`) }),
  ).toBeVisible();
  await (await railLink(page, 'Shared')).click();
  await shellReady(page);
  await expect(page.getByRole('heading', { name: 'Shared', level: 1 })).toBeVisible();
  const search = page.getByRole('search').getByLabel('Search shared items');
  await search.fill(made.name);
  await search.press('Enter');
  const download = page.getByRole('link', { name: new RegExp(`Download ${filename}`) });
  await expect(download).toBeVisible();
  await expect(page.getByRole('button', { name: `Preview ${filename}` })).toBeVisible();
  const received = page.waitForEvent('download');
  await download.click();
  expect((await received).suggestedFilename()).toBe(filename);
  await page.getByRole('button', { name: 'Links', exact: true }).click();
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
  await expect(page.getByText(`${made.name} confidential`, { exact: true })).toHaveCount(0);
  // One inspection batch covers the existing two themes and a true phone-width composition.
  if (info.project.name === 'chromium-light') {
    for (const width of [1440, 390])
      for (const theme of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((value) => {
          localStorage.setItem('purlay.theme', value);
        }, theme);
        await page.reload();
        await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible();
        await expect(page.locator('body')).toHaveJSProperty('scrollWidth', width);
        await expectNoAxe();
        await page.screenshot({
          path: info.outputPath(`shared-${String(width)}-${theme}.png`),
          fullPage: true,
        });
      }
  }
  await api('carol').edit(reply.id, `[${made.name} updated](http://intranet/purchasing/current)`);
  await expect(page.getByRole('link', { name: `${made.name} updated`, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: title, exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Go to message', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`message=${reply.id}`));
  await expect(
    page.locator('[data-message-row]').filter({ hasText: `${made.name} updated` }),
  ).toBeVisible();
});
