/**
 * How long a workspace keeps its history (D-139 §4), chosen in the app against the real API on the
 * Data & retention page of Settings (D-146): the owner picks a shorter window, is told what it will
 * delete, saves it — and the trail says so.
 */
import { expect, test } from './fixtures';
import { openSettings } from './support';

test.describe('keeping history', () => {
  test('an owner shortens it, is told what goes, and the trail says who chose it', async ({
    page,
    signIn,
    tenant,
    expectNoAxe,
  }) => {
    await signIn();
    const main = await openSettings(page, tenant.slug, 'data', 'Data & retention');
    const card = main.getByRole('region', { name: 'History' });
    const select = card.getByLabel('Keep history');
    await expect(select).toHaveValue('forever');
    await select.selectOption({ label: '90 days' });
    await expect(card.getByRole('note')).toContainText('older than 90 days will be deleted');
    await expectNoAxe();
    await card.getByRole('button', { name: 'Delete history older than 90 days' }).click();
    // Saved: what is held is what was chosen, so there is nothing more to warn of.
    await expect(card.getByRole('note')).toHaveCount(0);
    await expect(select).toHaveValue('90');

    const trail = await openSettings(page, tenant.slug, 'audit', 'Audit log');
    await expect(
      trail.getByText(/changed how long history is kept from forever to 90 days/),
    ).toBeVisible();
  });
});
