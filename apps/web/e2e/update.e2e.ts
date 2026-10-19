/**
 * A tab left open across a deployment (#334): its build's chunks are gone from the server, the part
 * that asked for one fails as it already does, and the person is offered a reload — in the page, by
 * the event Vite really dispatches, not a stand-in.
 *
 * The deployment is staged by answering the Turkish catalogue's chunk `404`, which is what the server
 * answers for an asset of a build it no longer has (D-102).
 */
import { expect, test } from './fixtures';
import { openSettings, shellReady } from './support';

test.describe('after a deployment', () => {
  test('a chunk that is gone offers a reload, and Reload reloads', async ({
    page,
    signIn,
    tenant,
  }) => {
    await signIn();
    // The language is chosen on the Preferences page of Settings (D-146).
    const main = await openSettings(page, tenant.slug, 'preferences', 'Preferences');
    await page.route('**/assets/tr-*.js', (route) => route.fulfill({ status: 404, body: '' }));

    await main.getByRole('radio', { name: 'Türkçe' }).click();

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
    await expect(main.getByRole('heading', { level: 1, name: 'Preferences' })).toBeVisible();
    await main.getByRole('radio', { name: 'Türkçe' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  });
});
