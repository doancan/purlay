/**
 * A tab left open across a deployment (#334): its build's chunks are gone from the server, the part
 * that asked for one fails as it already does, and the person is offered a reload — in the page, by
 * the event Vite really dispatches, not a stand-in.
 *
 * The deployment is staged by answering the Turkish catalogue's chunk `404`, which is what the server
 * answers for an asset of a build it no longer has (D-102).
 */
import { expect, test } from './fixtures';
import { isNarrow, openNav, shellReady } from './support';

test.describe('after a deployment', () => {
  test('a chunk that is gone offers a reload, and Reload reloads', async ({
    page,
    signIn,
    tenant,
  }) => {
    await signIn();
    await page.goto(`/w/${tenant.slug}`);
    await shellReady(page);
    await page.route('**/assets/tr-*.js', (route) => route.fulfill({ status: 404, body: '' }));

    await openNav(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitemradio', { name: 'Türkçe' }).click();

    // Narrow, the navigation is a modal over the page: the person closes it to reach the page.
    // Choosing closes the menu and gives focus back to Settings, whose tooltip opens on focus, and
    // Escape closes one layer, the top one: the tooltip first, then the overlay. One Escape pressed
    // before focus came back closed the overlay; pressed after, it closed the tooltip and left the
    // overlay over the bar — a race this lost about one run in thirty. So: wait for each layer.
    if (isNarrow(page)) {
      const overlay = page.getByRole('dialog', { name: 'Workspace' });
      await expect(overlay.getByRole('button', { name: 'Settings' })).toBeFocused();
      await expect(page.getByRole('tooltip', { name: 'Settings' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('tooltip')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(overlay).toHaveCount(0);
    }
    const bar = page.getByRole('status').filter({ hasText: 'Purlay was updated' });
    await expect(bar).toBeVisible();
    // The language whose words did not come stays unchosen: the page is still in English.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    // The new build is there to be had: the reload brings it, and Turkish can be chosen again.
    await page.unroute('**/assets/tr-*.js');
    const reloaded = page.waitForEvent('load');
    await bar.getByRole('button', { name: 'Reload' }).click();
    await reloaded;
    await shellReady(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await openNav(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitemradio', { name: 'Türkçe' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  });
});
