/**
 * Members and roles (`ARCHITECTURE.md` §7.4, D-146), through the real API: the owner makes somebody
 * an admin and back on the Members page, and what the server kept is what the page shows after a
 * reload.
 */
import { expect, test } from './fixtures';
import { openSettings } from './support';

test.describe('members and roles', () => {
  test('an owner makes a member an admin, and back, and the server keeps each', async ({
    page,
    signIn,
    tenant,
    world,
  }) => {
    await signIn();
    const main = await openSettings(page, tenant.slug, 'members', 'Members');
    const carol = world.personas.carol.username;
    const role = main.getByRole('combobox', { name: /^Role of / });
    // The owner's own row offers nothing; the others offer a role each.
    await expect(role).toHaveCount(3);
    const carolsRole = main.locator('li', { hasText: `@${carol}` }).getByRole('combobox');
    await carolsRole.selectOption('admin');
    await expect(carolsRole).toHaveValue('admin');

    await page.reload();
    await expect(main.getByRole('heading', { level: 1, name: 'Members' })).toBeVisible();
    await expect(carolsRole).toHaveValue('admin');
    await carolsRole.selectOption('member');
    await expect(carolsRole).toHaveValue('member');
  });

  test('a person is found by name, and the role filter narrows the list', async ({
    page,
    signIn,
    tenant,
    world,
  }) => {
    await signIn();
    const main = await openSettings(page, tenant.slug, 'members', 'Members');
    const carol = world.personas.carol.username;
    const rows = main.getByRole('list', { name: 'Members' }).getByRole('listitem');
    await main.getByRole('searchbox', { name: 'Search by name or handle' }).fill(carol);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`@${carol}`);
    await main.getByRole('searchbox', { name: 'Search by name or handle' }).fill('');
    await main.getByRole('combobox', { name: 'Role', exact: true }).selectOption('owner');
    await expect(rows.filter({ hasText: `@${world.personas.dogancan.username}` })).toHaveCount(1);
    await expect(rows.filter({ hasText: `@${carol}` })).toHaveCount(0);
  });
});
