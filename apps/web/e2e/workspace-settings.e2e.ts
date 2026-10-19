/**
 * Renaming a workspace (D-124, D-146), against the real API and the real socket: from the workspace
 * menu's Workspace settings to the General page, the name changes in the tab that saved it and,
 * without a reload, in another tab of the same person; the address does not.
 *
 * As an outsider in a workspace of their own (`fixtures.ts`): renaming the seeded workspace would
 * change what every other test of the run reads and photographs.
 */
import { expect, test } from './fixtures';
import { openNav, shellReady } from './support';

test.describe('workspace settings', () => {
  test('a new name shows in another tab without a reload, and the address stays', async ({
    asOutsider,
    workspaceOf,
  }) => {
    const workspace = await workspaceOf('frank');
    const here = await asOutsider('frank', 0);
    const there = await asOutsider('frank', 1);
    for (const page of [here, there]) {
      await page.goto(`/w/${workspace.slug}`);
      await shellReady(page);
    }
    const renamed = `Renamed ${workspace.slug.slice(-12)}`;

    await openNav(here);
    await here.getByRole('button', { name: 'Switch workspace' }).click();
    await here.getByRole('menuitem', { name: /^Workspace settings/ }).click();
    const main = here.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
    expect(new URL(here.url()).pathname).toBe(`/w/${workspace.slug}/settings/general`);
    await expect(main).toContainText(`/w/${workspace.slug}`);
    await main.getByLabel('Name').fill(renamed);
    await main.getByRole('button', { name: 'Save' }).click();
    await expect(main.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
    // The settings' navigation leads back to the workspace by its new name.
    await expect(
      (await openNav(here)).getByRole('link', { name: `Back to ${renamed}` }),
    ).toBeVisible();

    // The other tab heard it over its socket: no reload, and still at the same address.
    await expect((await openNav(there)).getByText(renamed)).toBeVisible();
    expect(new URL(there.url()).pathname.startsWith(`/w/${workspace.slug}`)).toBe(true);
  });
});
