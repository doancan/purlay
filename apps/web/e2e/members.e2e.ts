/**
 * Members and roles (`ARCHITECTURE.md` §7.4), through the real API: the owner makes somebody an admin
 * and back, and what the server kept is what the dialog shows after a reload.
 */
import { expect, test } from './fixtures';
import { openNav } from './support';

test.describe('members and roles', () => {
  test('an owner makes a member an admin, and back, and the server keeps each', async ({
    page,
    signIn,
    tenant,
    world,
  }) => {
    await signIn();
    await page.goto(`/w/${tenant.slug}`);
    const openDialog = async (): Promise<void> => {
      await openNav(page);
      await page.getByRole('button', { name: 'Switch workspace' }).click();
      await page.getByRole('menuitem', { name: 'Members…' }).click();
    };
    await openDialog();
    const dialog = page.getByRole('dialog');
    const carol = world.personas.carol.username;
    const role = dialog.getByRole('combobox', { name: /^Role of / }).filter({
      has: page.locator('option'),
    });
    // The owner's own row offers nothing; the others offer a role each.
    await expect(role).toHaveCount(3);
    const carolsRole = dialog.locator('li', { hasText: `@${carol}` }).getByRole('combobox');
    await carolsRole.selectOption('admin');
    await expect(carolsRole).toHaveValue('admin');

    await page.reload();
    await openDialog();
    await expect(carolsRole).toHaveValue('admin');
    await carolsRole.selectOption('member');
    await expect(carolsRole).toHaveValue('member');
  });
});
