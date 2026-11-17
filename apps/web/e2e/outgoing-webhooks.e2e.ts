/** Real channel configuration and durable queue from the browser (D-312). */
import { expect, test } from './fixtures';

test.describe('outgoing webhooks', () => {
  test('configure, queue a test, pause/resume, rotate once and revoke at desktop and phone widths', async ({
    page,
    signIn,
    room,
    expectNoAxe,
  }) => {
    const made = await room();
    await signIn();
    await page.goto(made.path);
    await page.getByRole('button', { name: made.name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Details of #${made.name}` });
    await dialog.getByRole('tab', { name: 'Integrations' }).click();
    const hooks = dialog.getByRole('region', { name: 'Outgoing webhooks' });
    await expect(hooks.getByText('No outgoing webhooks yet.')).toBeVisible();
    await hooks.getByLabel('Webhook name', { exact: true }).fill('External CI İstanbul');
    await hooks.getByLabel('Destination HTTPS URL').fill('https://example.com/purlay');
    await hooks.getByLabel('Thread resolved', { exact: true }).check();
    await hooks.getByRole('button', { name: 'Create outgoing webhook' }).click();
    await expect(hooks.getByRole('heading', { name: 'Signing secret' })).toBeVisible();
    await expect(hooks.locator('code')).toHaveText(/^[a-f0-9]{64}$/);
    const secret = await hooks.locator('code').textContent();
    await hooks.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(hooks.locator('code')).toHaveCount(0);
    await hooks.getByRole('button', { name: 'Send test event' }).click();
    await expect(hooks.getByText(/webhook.test · Waiting/)).toBeVisible();
    await expect(hooks.getByText(/0 attempts/)).toBeVisible();
    await hooks.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(hooks.getByRole('button', { name: 'Send test event' })).toBeDisabled();
    await hooks.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(hooks.getByRole('button', { name: 'Send test event' })).toBeEnabled();
    await hooks.getByRole('button', { name: 'Renew secret', exact: true }).click();
    await expect(hooks.getByText(/Renew the secret\?/)).toBeVisible();
    await hooks.getByRole('button', { name: 'Renew secret', exact: true }).last().click();
    await expect(hooks.locator('code')).toHaveText(/^[a-f0-9]{64}$/);
    expect(await hooks.locator('code').textContent()).not.toBe(secret);
    await hooks.getByRole('button', { name: 'Done', exact: true }).click();
    for (const width of [1440, 768, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(hooks.getByRole('button', { name: 'Deliveries', exact: true })).toBeVisible();
      await expectNoAxe(dialog);
      await hooks.screenshot({
        path: test.info().outputPath(`outgoing-webhooks-${String(width)}.png`),
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    await hooks.getByRole('button', { name: 'Revoke', exact: true }).click();
    await hooks.getByRole('button', { name: 'Revoke', exact: true }).last().click();
    await expect(hooks.getByText('No outgoing webhooks yet.')).toBeVisible();
  });
});

test('Turkish channel webhook setup, test and revocation at phone width', async ({
  page,
  signIn,
  room,
  expectNoAxe,
}) => {
  const made = await room();
  await signIn();
  await page.goto(made.path);
  await page.evaluate(() => {
    localStorage.setItem('purlay.locale', 'tr');
  });
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: made.name, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `#${made.name} ayrıntıları` });
  await dialog.getByRole('tab', { name: 'Entegrasyonlar' }).click();
  const hooks = dialog.getByRole('region', { name: 'Giden webhook’lar' });
  await hooks.getByLabel('Webhook adı', { exact: true }).fill('Dağıtım servisi');
  await hooks.getByLabel('Hedef HTTPS adresi').fill('https://example.com/purlay-tr');
  await hooks.getByRole('button', { name: 'Giden webhook oluştur' }).click();
  await expect(hooks.getByRole('heading', { name: 'İmza anahtarı' })).toBeVisible();
  await hooks.getByRole('button', { name: 'Tamam', exact: true }).click();
  await hooks.getByRole('button', { name: 'Test olayı gönder' }).click();
  await expect(hooks.getByText(/webhook.test · Bekliyor/)).toBeVisible();
  await expectNoAxe(dialog);
  await hooks.getByRole('button', { name: 'İptal et', exact: true }).click();
  await hooks.getByRole('button', { name: 'İptal et', exact: true }).last().click();
  await expect(hooks.getByText('Henüz giden webhook yok.')).toBeVisible();
});
