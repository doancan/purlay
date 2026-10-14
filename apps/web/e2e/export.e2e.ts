/**
 * An owner's export of the workspace (D-140), in the app against the real API: asked for, made by the
 * API process in the background, downloaded once as an archive `tar` opens — and the link not offered
 * again — and the trail says who exported it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { openNav } from './support';

test.describe('exporting a workspace', () => {
  test('an owner asks, waits for it, downloads it once, and the trail says so', async ({
    page,
    signIn,
    tenant,
    expectNoAxe,
  }) => {
    await signIn();
    await page.goto(`/w/${tenant.slug}`);
    await openNav(page);
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page.getByRole('menuitem', { name: 'Export workspace…' }).click();
    // By its name: on a narrow screen the navigation drawer is a dialog too.
    const dialog = page.getByRole('dialog', { name: /^Export / });
    await expect(dialog.getByText('You have not exported this workspace yet.')).toBeVisible();
    await expectNoAxe();
    await dialog.getByRole('button', { name: 'Export' }).click();

    // Made in the background; the list is read again until it is ready.
    const link = dialog.getByRole('link', { name: /^Download \(.+\) — once, until/ });
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
    await expect(dialog.getByText(/^Downloaded\./)).toBeVisible();
    await expect(dialog.getByRole('link')).toHaveCount(0);
    const again = await page.request.get(href ?? '');
    expect(again.status()).toBe(404);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page.getByRole('menuitem', { name: 'Audit log…' }).click();
    const trail = page.getByRole('dialog', { name: /Audit log/ });
    await expect(trail.getByText(/exported the workspace, with \d+ messages/)).toBeVisible();
  });
});
