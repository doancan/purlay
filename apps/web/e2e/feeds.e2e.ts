/**
 * A repository connected to a channel, the whole way (#79, D-134): the workspace's owner opens the
 * channel's details in a real browser, connects a repository through the API, is shown the address,
 * the content type and the secret once, and the channel lists it — clean of contrast and role
 * violations in both themes and at both widths.
 */
import { expect, test } from './fixtures';

test.describe('a channel’s repositories', () => {
  test('connected by the owner: what GitHub needs is shown once, and the feed is listed', async ({
    page,
    signIn,
    room,
    expectNoAxe,
  }) => {
    const made = await room();
    await signIn();
    await page.goto(made.path);
    await page.getByRole('button', { name: made.name, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Details of #${made.name}` });
    // The repositories are an owner's own tab (D-154).
    await dialog.getByRole('tab', { name: 'Integrations' }).click();
    const feeds = dialog.getByRole('region', { name: 'GitHub repositories' });
    await expect(feeds.getByText(/No repository is connected/)).toBeVisible();

    await feeds.getByLabel(/^Repository/).fill('acme/feeds');
    await feeds.getByLabel('Releases').check();
    await feeds.getByRole('button', { name: 'Connect' }).click();

    const setup = feeds.getByRole('region', { name: /Add this webhook to acme\/feeds/ });
    await expect(setup).toBeVisible();
    await expect(setup.getByText(/\/api\/webhooks\/github\/[0-9a-f-]{36}$/)).toBeVisible();
    await expect(setup.getByText('application/json')).toBeVisible();
    await expect(setup.getByText(/^[0-9a-f]{64}$/)).toBeVisible();
    await expectNoAxe(dialog);

    await setup.getByRole('button', { name: 'Done' }).click();
    await expect(feeds.getByText('acme/feeds')).toBeVisible();
    await expect(feeds.getByText(/Pushes, Releases · No delivery yet/)).toBeVisible();
    await expect(feeds.getByText(/^[0-9a-f]{64}$/)).toHaveCount(0);
  });
});
