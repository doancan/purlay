/**
 * A person's export of their own data (D-241), on Sessions & account against the real API: asked for,
 * made by the API process in the background, downloaded once as an archive `tar` opens — holding the
 * message they wrote and not the one somebody else wrote beside it — and the link not offered again.
 *
 * As newcomers (`fixtures.ts`): a person may ask for only a few exports a day, and every project of the
 * run would ask as the same seeded person.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Channel } from '@purlay/types';
import { expect, test, workspaceFor } from './fixtures';
import { shellReady } from './support';

test.describe('exporting one’s own data', () => {
  test('a person asks, waits for it, downloads it once, and finds their words and nobody else’s', async ({
    newcomer,
    expectNoAxe,
  }) => {
    const person = await newcomer('exports-self');
    const other = await newcomer('writes-beside');
    const workspace = await workspaceFor(person, other);
    const channel = await person.api.post<Channel>(`/api/workspaces/${workspace.id}/channels`, {
      name: 'export-room',
      type: 'public',
    });
    await other.api.join(channel.id);
    await person.api.say(channel.id, 'Dışa aktarılacak söz — mine');
    await other.api.say(channel.id, 'somebody else’s words, beside mine');

    const page = await person.page();
    await page.goto(`/w/${workspace.slug}`);
    await shellReady(page);
    await page.goto(`/w/${workspace.slug}/settings/account`);
    const card = page.getByRole('region', { name: 'Your data' });
    await expect(card.getByText('You have not exported your data yet.')).toBeVisible();
    await expectNoAxe(card);
    await card.getByRole('button', { name: 'Export my data' }).click();

    // Made in the background; the list is read again until it is ready.
    const link = card.getByRole('link', { name: /^Download \(.+\) — once, until/ });
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expectNoAxe(card);
    const href = await link.getAttribute('href');
    expect(href).toMatch(/^\/api\/me\/exports\/[0-9a-f-]+\/download$/);
    // Somebody else, holding the address: refused, and the export is not spent by it.
    const theirs = await other.page();
    expect((await theirs.request.get(href ?? '')).status()).toBe(404);
    const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
    expect(download.suggestedFilename()).toMatch(/^purlay-data-\d{4}-\d{2}-\d{2}\.tar$/);
    const scratch = mkdtempSync(join(tmpdir(), 'purlay-e2e-my-data-'));
    const saved = join(scratch, 'export.tar');
    await download.saveAs(saved);
    execFileSync('tar', ['-xf', saved, '-C', scratch]);
    const messages = readFileSync(join(scratch, 'export', 'messages.ndjson'), 'utf8');
    expect(messages).toContain('Dışa aktarılacak söz — mine');
    expect(messages).not.toContain('somebody else’s words');
    const people = readFileSync(join(scratch, 'export', 'users.ndjson'), 'utf8');
    expect(people).toContain(person.username);
    expect(people).not.toContain(other.username);

    // Once: the link is gone here, and the server refuses it a second time.
    await expect(card.getByText(/^Downloaded\./)).toBeVisible();
    await expect(card.getByRole('link')).toHaveCount(0);
    expect((await page.request.get(href ?? '')).status()).toBe(404);
  });
});
