/**
 * How long a workspace keeps its history (D-139 §4), chosen in the app against the real API: the
 * owner picks a shorter window, is told what it will delete, saves it — and the trail says so.
 */
import { expect, test } from './fixtures';
import { openNav } from './support';

test.describe('keeping history', () => {
  test('an owner shortens it, is told what goes, and the trail says who chose it', async ({
    page,
    signIn,
    tenant,
    expectNoAxe,
  }) => {
    await signIn();
    await page.goto(`/w/${tenant.slug}`);
    await openNav(page);
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page.getByRole('menuitem', { name: 'Keep history…' }).click();
    // By its name: on a narrow screen the navigation drawer is a dialog too.
    const dialog = page.getByRole('dialog', { name: /keeps its history/ });
    const select = dialog.getByLabel('Keep history');
    await expect(select).toHaveValue('forever');
    await select.selectOption({ label: '90 days' });
    await expect(dialog.getByRole('note')).toContainText('older than 90 days will be deleted');
    await expectNoAxe();
    await dialog.getByRole('button', { name: 'Delete history older than 90 days' }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page.getByRole('menuitem', { name: 'Audit log…' }).click();
    await expect(
      page
        .getByRole('dialog', { name: /Audit log/ })
        .getByText(/changed how long history is kept from forever to 90 days/),
    ).toBeVisible();
  });
});
