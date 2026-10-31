/**
 * The audit trail (D-26), read in the app against the real API on the Audit log page of Settings
 * (D-146): what an owner just did is on it, in words, at the top — and it narrows by action from the
 * keyboard, keeps the filter through a reload, and downloads what it keeps as a file (D-222).
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { openSettings, trailLine } from './support';

test.describe('the audit log', () => {
  test('shows an invitation link the owner just made, in words', async ({
    page,
    signIn,
    tenant,
    api,
  }) => {
    await api('dogancan').post(`/api/workspaces/${tenant.workspaceId}/invitations`, {});
    await signIn();
    const main = await openSettings(page, tenant.slug, 'audit', 'Audit log');
    await expect(main.getByText(/made an invitation link/).first()).toBeVisible();
  });

  test('narrows by action, keeps it through a reload, and downloads what it keeps', async ({
    page,
    signIn,
    tenant,
    api,
    expectNoAxe,
  }) => {
    await api('dogancan').post(`/api/workspaces/${tenant.workspaceId}/invitations`, {});
    await signIn();
    const main = await openSettings(page, tenant.slug, 'audit', 'Audit log');
    const action = main.getByLabel('Action');
    await action.focus();
    await action.selectOption({ label: 'Invitation link made' });
    await expect(page).toHaveURL(/\/settings\/audit\?action=invitation\.created$/);
    const trail = main.getByRole('list', { name: 'Audit log' });
    await expect(trail.getByText(/made an invitation link/).first()).toBeVisible();
    // Every line the server answered with is the one action: narrowed there, not here.
    for (const line of await trail.locator('[data-audit-line]').allTextContents()) {
      expect(line).toMatch(/made an invitation link/);
    }
    await expectNoAxe();

    await page.reload();
    await expect(main.getByLabel('Action')).toHaveValue('invitation.created');

    const csv = main.getByRole('link', { name: 'Download the filtered log as CSV' });
    const [download] = await Promise.all([page.waitForEvent('download'), csv.click()]);
    expect(download.suggestedFilename()).toMatch(/-audit-\d{4}-\d{2}-\d{2}\.csv$/);
    const saved = join(mkdtempSync(join(tmpdir(), 'purlay-e2e-audit-')), 'audit.csv');
    await download.saveAs(saved);
    const bytes = readFileSync(saved);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const [header, ...rows] = bytes.subarray(3).toString('utf8').split('\r\n');
    expect(header).toBe(
      'id,createdAt,action,actorId,actorUsername,actorDisplayName,targetType,targetId,metadata',
    );
    const kept = rows.filter((row) => row !== '');
    expect(kept.length).toBeGreaterThan(0);
    for (const row of kept) expect(row).toContain(',invitation.created,');

    // The download is on the trail, for anybody who reads it next.
    await main.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page).toHaveURL(/\/settings\/audit$/);
    await expect((await trailLine(main, /downloaded the audit log/)).first()).toBeVisible();
  });
});
