/**
 * The audit trail (D-26), read in the app against the real API: what an owner just did is on it, in
 * words, at the top.
 */
import { expect, test } from './fixtures';
import { openNav } from './support';

test.describe('the audit log', () => {
  test('shows an invitation link the owner just made, in words', async ({
    page,
    signIn,
    tenant,
    api,
  }) => {
    await api('dogancan').post(`/api/workspaces/${tenant.workspaceId}/invitations`, {});
    await signIn();
    await page.goto(`/w/${tenant.slug}`);
    await openNav(page);
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page.getByRole('menuitem', { name: 'Audit log…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/made an invitation link/).first()).toBeVisible();
  });
});
