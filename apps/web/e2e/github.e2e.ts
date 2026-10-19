/**
 * The workspace's GitHub token (D-23, `PRD.md` §4.8), through the real API: an owner gives it on the
 * Integrations page of Settings (D-146), sees it is set without ever seeing it again, and takes it
 * away.
 */
import { expect, test } from './fixtures';
import { openSettings } from './support';

test.describe('the GitHub connection', () => {
  test('an owner saves a token, sees it connected, and disconnects it', async ({
    page,
    signIn,
    tenant,
  }) => {
    await signIn();
    const main = await openSettings(page, tenant.slug, 'integrations', 'Integrations');
    await expect(main.getByText(/^Not connected: links/)).toBeVisible();

    await main.getByLabel('Token').fill('github_pat_e2e_not_a_real_one');
    await main.getByRole('button', { name: 'Save token' }).click();
    await expect(main.getByText(/Connected since/)).toBeVisible();
    // The token goes one way: the field is emptied, and nothing on the page carries it.
    await expect(main.getByLabel('Token')).toHaveValue('');
    expect(await page.content()).not.toContain('github_pat_e2e_not_a_real_one');

    await main.getByRole('button', { name: 'Disconnect' }).click();
    await expect(main.getByText(/^Not connected: links/)).toBeVisible();
  });
});
