/**
 * The account menu at the sidebar's foot (D-124), against the real API: signing out everywhere
 * ends a session in another browser.
 *
 * As an outsider (`fixtures.ts`): signing out everywhere ends every session the person holds, and
 * done as one of the seeded four it would sign every other test of the run out.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openNav, shellReady } from './support';

const accountMenu = async (page: Page): Promise<void> => {
  await openNav(page);
  await page.getByRole('button', { name: /^Account: / }).click();
};

test.describe('the account menu', () => {
  test('signing out everywhere ends the session in the other browser too', async ({
    asOutsider,
    workspaceOf,
  }) => {
    const workspace = await workspaceOf('erin');
    // Sessions of their own: this ends every session erin holds, the seeded ones included.
    const here = await asOutsider('erin', 'fresh');
    const there = await asOutsider('erin', 'fresh');
    for (const page of [here, there]) {
      await page.goto(`/w/${workspace.slug}`);
      await shellReady(page);
    }

    await accountMenu(here);
    await here.getByRole('menuitem', { name: 'Sign out everywhere…' }).click();
    const dialog = here.getByRole('dialog', { name: 'Sign out everywhere?' });
    await dialog.getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(here).toHaveURL(/\/sign-in/);

    // The other browser was told over its socket, and its session is gone on the server too.
    await expect(there).toHaveURL(/\/sign-in/);
    await expect(there.getByRole('heading', { level: 1, name: 'Sign in to Purlay' })).toBeVisible();
    await there.goto(`/w/${workspace.slug}`);
    await expect(there).toHaveURL(/\/sign-in/);
  });
});
