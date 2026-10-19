/**
 * An owner's export of the workspace (D-140), on the Data & retention page of Settings (D-146) against
 * the real API: asked for, made by the API process in the background, downloaded once as an archive `tar` opens — and the link not offered
 * again — and the trail says who exported it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { openSettings } from './support';

test.describe('exporting a workspace', () => {
  test('an owner asks, waits for it, downloads it once, and the trail says so', async ({
    page,
    signIn,
    tenant,
    expectNoAxe,
  }) => {
    await signIn();
    const main = await openSettings(page, tenant.slug, 'data', 'Data & retention');
    const card = main.getByRole('region', { name: 'Export' });
    await expect(card.getByText('You have not exported this workspace yet.')).toBeVisible();
    await expectNoAxe();
    await card.getByRole('button', { name: 'Export' }).click();

    // Made in the background; the list is read again until it is ready.
    const link = card.getByRole('link', { name: /^Download \(.+\) — once, until/ });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expectNoAxe();
    const href = await link.getAttribute('href');
    expect(href).toMatch(/\/download$/);
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    const saved = join(mkdtempSync(join(tmpdir(), 'purlay-e2e-export-')), 'export.tar');
    await download.saveAs(saved);
    const entries = execFileSync('tar', ['-tf', saved], { encoding: 'utf8' }).split('\n');
    expect(entries).toContain('export/manifest.json');
    expect(entries).toContain('export/messages.ndjson');

    // Once: the link is gone here, and the server refuses it a second time.
    await expect(card.getByText(/^Downloaded\./)).toBeVisible();
    await expect(card.getByRole('link')).toHaveCount(0);
    const again = await page.request.get(href ?? '');
    expect(again.status()).toBe(404);

    const trail = await openSettings(page, tenant.slug, 'audit', 'Audit log');
    await expect(trail.getByText(/exported the workspace, with \d+ messages/)).toBeVisible();
  });
});
