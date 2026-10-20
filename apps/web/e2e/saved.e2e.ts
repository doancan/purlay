/**
 * Saved items, the whole way (#484, D-128): Save beside React on a message in a real browser, the
 * Saved view from the rail, moved to Completed, and found in that tab — the server keeping it all.
 *
 * In a workspace of the test's own — Bob makes it and invites Alice — so the seeded workspace, which
 * the screenshots draw, gets no saves.
 */
import { expect, test } from './fixtures';
import { apiAs, openNav, shellReady } from './support';

test.describe('saved items', () => {
  test('a message saved from the feed is found in Saved, completed, and kept there', async ({
    page,
    signIn,
    tenant,
  }) => {
    const bob = apiAs(tenant, 'bob');
    const alice = apiAs(tenant, 'alice');
    const slug = `saved-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await bob.post<{ id: string }>('/api/workspaces', { name: 'Saved', slug });
    const { token } = await bob.post<{ token: string }>(
      `/api/workspaces/${workspace.id}/invitations`,
    );
    await alice.post('/api/invitations/accept', { token });
    const channel = await bob.post<{ id: string }>(`/api/workspaces/${workspace.id}/channels`, {
      name: 'ops',
    });
    await alice.post(`/api/channels/${channel.id}/join`);
    const words = `come back to this ${crypto.randomUUID().slice(0, 6)}`;
    const message = await bob.say(channel.id, words);

    await signIn('alice');
    await page.goto(`/w/${slug}/c/${channel.id}`);
    await shellReady(page);
    const row = page.locator(`[data-message-id="${message.id}"]`);
    await row.hover();
    await row.getByRole('button', { name: 'Save for later' }).click();
    await expect(row.getByRole('button', { name: 'Save for later' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await openNav(page);
    await page.getByRole('link', { name: 'Saved' }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/saved`));
    const main = page.getByRole('main');
    await expect(main.getByText(words)).toBeVisible();
    await main.getByRole('button', { name: 'Complete', exact: true }).click();
    await expect(main.getByText(words)).toBeHidden();
    await page.getByRole('button', { name: 'Completed', exact: true }).click();
    await expect(page).toHaveURL(/\?state=completed$/);
    await expect(main.getByText(words)).toBeVisible();

    const kept = await alice.get<{ messageId: string; state: string }[]>(
      `/api/workspaces/${workspace.id}/saved/ids`,
    );
    expect(kept).toEqual([expect.objectContaining({ messageId: message.id, state: 'completed' })]);
  });
});
