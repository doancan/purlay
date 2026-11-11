/**
 * An incoming webhook, the whole way (D-245): the workspace's owner makes one in the channel's details in
 * a real browser and is shown its address once; a tool posts markdown to that address with no cookie, as
 * `curl` would; and the message arrives, without a reload, in another member's open channel under the
 * hook's name, its markdown drawn and its markup inert — then, revoked, the address posts nothing.
 */
import { expect, test } from './fixtures';
import type { IncomingWebhookAnswer } from '@purlay/types';
import { openSettings } from './support';

test.describe('a channel’s incoming webhooks', () => {
  test('made by the owner, posted to by a tool, read live by another member, then revoked', async ({
    page,
    signIn,
    room,
    asPerson,
    request,
    expectNoAxe,
  }) => {
    const made = await room();
    await signIn();
    await page.goto(made.path);
    const alice = await asPerson('alice');
    await alice.goto(made.path);
    await expect(alice.getByRole('textbox', { name: `Message ${made.name}` })).toBeVisible();

    await page.getByRole('button', { name: made.name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Details of #${made.name}` });
    await dialog.getByRole('tab', { name: 'Integrations' }).click();
    const hooks = dialog.getByRole('region', { name: 'Incoming webhooks' });
    await expect(hooks.getByText(/No incoming webhook/)).toBeVisible();

    await hooks.getByLabel(/^Posts as/).fill('CI');
    await hooks.getByRole('button', { name: 'Make webhook' }).click();
    const setup = hooks.getByRole('region', { name: 'The address of CI' });
    await expect(setup).toBeVisible();
    const shown = setup.locator('[data-hook-address]');
    await expect(shown).toHaveText(/\/api\/webhooks\/incoming\/[0-9a-f-]{36}\/[0-9a-f]{64}$/);
    const address = (await shown.textContent()) ?? '';
    await expectNoAxe(dialog);

    await setup.getByRole('button', { name: 'Done' }).click();
    await expect(hooks.getByText('CI', { exact: true })).toBeVisible();
    await expect(hooks.getByText(/Not used yet/)).toBeVisible();
    await expect(hooks.getByText(/[0-9a-f]{64}/)).toHaveCount(0);

    // What a CI step's `curl -X POST -H 'Content-Type: application/json' -d …` sends: no cookie, no origin.
    const posted = await request.post(address, {
      data: { text: 'Deploy **failed** on İstanbul <img src=x onerror="window.hooked=1">' },
    });
    expect(posted.status()).toBe(201);
    const { messageId } = (await posted.json()) as { messageId: string };

    // Alice never reloaded: it reached her over her socket.
    const row = alice.locator(`[data-message-id="${messageId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('aria-label', /^CI, /);
    await expect(row.locator('[data-incoming-webhook]')).toHaveText('webhook');
    await expect(row.locator('strong')).toHaveText('failed');
    await expect(row.getByText(/İstanbul/)).toBeVisible();
    await expect(row.locator('img')).toHaveCount(0);
    expect(await alice.evaluate(() => (window as unknown as { hooked?: number }).hooked)).toBe(
      undefined,
    );
    await expectNoAxe(row);

    // Revoked from the list, the same address answers what an address nobody made answers.
    await hooks.getByRole('button', { name: 'Revoke CI' }).click();
    await hooks
      .getByRole('group', { name: /Revoke CI\?/ })
      .getByRole('button', { name: 'Revoke' })
      .click();
    await expect(hooks.getByText(/No incoming webhook/)).toBeVisible();
    const after = await request.post(address, { data: { text: 'again' } });
    expect(after.status()).toBe(404);
    expect(((await after.json()) as { error: { code: string } }).error.code).toBe(
      'INCOMING_WEBHOOK_NOT_FOUND',
    );
  });
  test('workspace setup posts a real test to its selected channel and shows the result', async ({
    page,
    signIn,
    room,
    asPerson,
    tenant,
    expectNoAxe,
  }, info) => {
    const made = await room();
    await signIn();
    const reader = await asPerson('alice');
    await reader.goto(made.path);
    await expect(reader.getByRole('textbox', { name: `Message ${made.name}` })).toBeVisible();
    await openSettings(page, tenant.slug, 'integrations', 'Integrations');
    const settings = page.getByRole('region', { name: 'Messages from other systems' });
    await settings.getByRole('combobox', { name: 'Channel' }).selectOption(made.id);
    await settings.getByLabel(/^Posts as/).fill('ERP');
    await settings.getByRole('button', { name: 'Make webhook' }).click();
    const setup = settings.getByRole('region', { name: 'The address of ERP' });
    await expect(setup).toBeVisible();
    const response = page.waitForResponse(
      (answer) =>
        answer.request().method() === 'POST' &&
        new URL(answer.url()).pathname.startsWith('/api/webhooks/incoming/'),
    );
    await setup.getByRole('button', { name: 'Send test message' }).click();
    const posted = await response;
    expect(posted.status()).toBe(201);
    const { messageId } = (await posted.json()) as IncomingWebhookAnswer;
    await expect(setup.getByRole('status')).toHaveText('Test message accepted by the channel.');
    const row = reader.locator(`[data-message-id="${messageId}"]`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Purlay webhook connection test');
    await expect(row.locator('[data-incoming-webhook]')).toHaveText('webhook');
    if (info.project.name.endsWith('narrow'))
      await page.setViewportSize({ width: 390, height: 844 });
    await expectNoAxe(settings);
    expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await settings.screenshot({
      path: info.outputPath('workspace-webhook-setup.png'),
      mask: [setup.locator('[data-hook-address]')],
    });
    await setup.getByRole('button', { name: 'Done' }).click();
    await expect(settings.locator('[data-hook-address]')).toHaveCount(0);
    await expect(settings.getByText(/Last posted/)).toBeVisible();
  });
});
