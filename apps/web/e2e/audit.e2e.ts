/**
 * The audit trail (D-26), read in the app against the real API on the Audit log page of Settings
 * (D-146): what an owner just did is on it, in words, at the top.
 */
import { expect, test } from './fixtures';
import { openSettings } from './support';

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
});
