/**
 * Pins, the whole way (#485, D-130): Pin beside Save on a message in a real browser, and the other
 * person, with the channel's pins open, sees it arrive — the mark in the feed and the row in the
 * panel — through the real socket, then Unpin from the panel take it away again for both.
 *
 * In a workspace of the test's own — Bob makes it and invites Alice — so the seeded workspace, which
 * the screenshots draw, gets no pins.
 */
import { expect, test } from './fixtures';
import { apiAs, shellReady } from './support';

test.describe('pins', () => {
  test('pinned by one person, the other sees it at once, and unpinned the same way', async ({
    page,
    signIn,
    tenant,
    asPerson,
  }) => {
    const bob = apiAs(tenant, 'bob');
    const alice = apiAs(tenant, 'alice');
    const slug = `pins-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await bob.post<{ id: string }>('/api/workspaces', { name: 'Pins', slug });
    const { token } = await bob.post<{ token: string }>(
      `/api/workspaces/${workspace.id}/invitations`,
    );
    await alice.post('/api/invitations/accept', { token });
    const channel = await bob.post<{ id: string }>(`/api/workspaces/${workspace.id}/channels`, {
      name: 'general',
    });
    await alice.post(`/api/channels/${channel.id}/join`);
    const words = `the runbook ${crypto.randomUUID().slice(0, 6)}`;
    const message = await bob.say(channel.id, words);
    const path = `/w/${slug}/c/${channel.id}`;

    const watcher = await asPerson('bob');
    await watcher.goto(path);
    await shellReady(watcher);
    await watcher.getByRole('button', { name: 'Pinned messages' }).click();
    const panel = watcher.getByRole('complementary', { name: /^Pinned/ });
    await expect(panel.getByRole('heading', { name: 'Nothing pinned yet' })).toBeVisible();

    await signIn('alice');
    await page.goto(path);
    await shellReady(page);
    const row = page.locator(`[data-message-id="${message.id}"]`);
    await row.hover();
    await row.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(row.getByText('Pinned', { exact: true })).toBeVisible();

    // Told by the socket, read again: no reload on Bob's side.
    await expect(panel.getByText(words)).toBeVisible();
    await expect(panel.getByText('Pinned by Alice', { exact: false })).toBeVisible();
    // On a narrow window the panel covers the feed: closed, the feed shows the mark too.
    await watcher.keyboard.press('Escape');
    await expect(
      watcher.locator(`[role="feed"] [data-message-id="${message.id}"]`).getByText('Pinned', {
        exact: true,
      }),
    ).toBeVisible();
    await watcher.getByRole('button', { name: 'Pinned messages' }).click();

    await panel.getByRole('button', { name: /^Unpin the message from/ }).click();
    await expect(panel.getByRole('heading', { name: 'Nothing pinned yet' })).toBeVisible();
    await expect(row.getByText('Pinned', { exact: true })).toBeHidden();
    expect(await alice.get<unknown[]>(`/api/channels/${channel.id}/pins`)).toEqual([]);
  });
});
