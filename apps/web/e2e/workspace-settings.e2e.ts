/**
 * Renaming a workspace (D-124), against the real API and the real socket: the name changes in the
 * tab that saved it and, without a reload, in another tab of the same person; the address does not.
 *
 * As an outsider in a workspace of their own (`fixtures.ts`): renaming the seeded workspace would
 * change what every other test of the run reads and photographs.
 */
import { expect, test } from './fixtures';
import { isNarrow, openNav, shellReady } from './support';

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
    await here.getByRole('menuitem', { name: 'Workspace settings…' }).click();
    const dialog = here.getByRole('dialog', { name: 'Workspace settings' });
    await expect(dialog).toContainText(`/w/${workspace.slug}`);
    await dialog.getByLabel('Name').fill(renamed);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toHaveCount(0);
    if (isNarrow(here)) await here.keyboard.press('Escape');
    await expect((await openNav(here)).getByText(renamed)).toBeVisible();

    // The other tab heard it over its socket: no reload, and still at the same address.
    await expect((await openNav(there)).getByText(renamed)).toBeVisible();
    expect(new URL(there.url()).pathname.startsWith(`/w/${workspace.slug}`)).toBe(true);
  });
});
