/**
 * The workspace's GitHub token (D-23, `PRD.md` §4.8), through the real API: an owner gives it from
 * the workspace menu, sees it is set without ever seeing it again, and takes it away.
 */
import { expect, test } from './fixtures';
import { openNav } from './support';

test.describe('the GitHub connection', () => {
  test('an owner saves a token, sees it connected, and disconnects it', async ({
    page,
    signIn,
    tenant,
  }) => {
    await signIn();
    await page.goto(`/w/${tenant.slug}`);
    await openNav(page);
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page.getByRole('menuitem', { name: 'GitHub connection…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Not connected/)).toBeVisible();

    await dialog.getByLabel('Token').fill('github_pat_e2e_not_a_real_one');
    await dialog.getByRole('button', { name: 'Save token' }).click();
    await expect(dialog.getByText(/Connected since/)).toBeVisible();
    // The token goes one way: the field is emptied, and nothing on the page carries it.
    await expect(dialog.getByLabel('Token')).toHaveValue('');
    expect(await page.content()).not.toContain('github_pat_e2e_not_a_real_one');

    await dialog.getByRole('button', { name: 'Disconnect' }).click();
    await expect(dialog.getByText(/Not connected/)).toBeVisible();
  });
});
