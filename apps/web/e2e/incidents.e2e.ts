/**
 * A channel's incident in two real browsers (#487, D-137): one person declares it, the other sees the
 * banner without a reload and moves it, and the first sees that — through the route, the frame and
 * both caches.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';

const banner = (page: Page): Locator => page.getByRole('region', { name: 'Incident in progress' });

const panelOf = async (page: Page): Promise<Locator> => {
  const control = page.getByRole('button', { name: 'Incident', exact: true });
  if (await control.isVisible()) await control.click();
  else {
    await page.getByRole('button', { name: 'Channel menu' }).click();
    await page.getByRole('menuitem', { name: 'Incident' }).click();
  }
  const panel = page.getByRole('complementary', { name: /Incident/ });
  await expect(panel).toBeVisible();
  return panel;
};

test.describe('an incident', () => {
  test('declared by one person is a banner for the other, who moves it, and the first sees it move', async ({
    page,
    signIn,
    room,
    asPerson,
    expectNoAxe,
  }) => {
    const made = await room();
    await signIn();
    await page.goto(made.path);
    const alice = await asPerson('alice');
    await alice.goto(made.path);

    const panel = await panelOf(page);
    await expect(panel.getByText('No incident')).toBeVisible();
    await panel.getByRole('button', { name: 'Severity 1' }).click();
    await panel.getByRole('button', { name: 'Declare an incident' }).click();
    await expect(panel.getByText(/declared it at SEV1/)).toBeVisible();
    await expectNoAxe(panel);
    // Closed, the conversation is back — on a narrow window the panel covered it — with its banner.
    await page.keyboard.press('Escape');
    await expect(banner(page)).toContainText('SEV1');

    await expect(banner(alice)).toContainText('SEV1');
    await expect(banner(alice)).toContainText('Investigating');
    await banner(alice).getByRole('button', { name: 'Details' }).click();
    const hers = alice.getByRole('complementary', { name: /Incident/ });
    await hers.getByRole('button', { name: 'Mitigating' }).click();

    await expect(banner(page)).toContainText('Mitigating');
    await banner(page).getByRole('button', { name: 'Details' }).click();
    await expect(
      page
        .getByRole('complementary', { name: /Incident/ })
        .getByText('Alice Chen moved it to Mitigating'),
    ).toBeVisible();
  });
});
