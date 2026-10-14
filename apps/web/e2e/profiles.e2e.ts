/**
 * Profiles, the whole way (#488, D-131): Alice sets her title, time zone and status from the account
 * menu, and Bob — in a conversation with her, already open — sees the time where she is and her
 * status in its heading, and her profile beside it, without reloading: her change told his tab to
 * read the members again.
 *
 * In a workspace of the test's own, so the seeded people, which the screenshots draw, keep theirs.
 */
import { expect, test } from './fixtures';
import { apiAs, openNav, shellReady } from './support';

test.describe('profiles', () => {
  test('set by one person, shown to the other in their conversation at once', async ({
    page,
    signIn,
    tenant,
    asPerson,
  }) => {
    const bob = apiAs(tenant, 'bob');
    const alice = apiAs(tenant, 'alice');
    const slug = `profiles-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await bob.post<{ id: string }>('/api/workspaces', { name: 'Profiles', slug });
    const { token } = await bob.post<{ token: string }>(
      `/api/workspaces/${workspace.id}/invitations`,
    );
    await alice.post('/api/invitations/accept', { token });
    const me = await alice.get<{ user: { id: string } }>('/api/me');
    const conversation = await bob.post<{ id: string }>(
      `/api/workspaces/${workspace.id}/conversations`,
      { userIds: [me.user.id] },
    );
    const path = `/w/${slug}/c/${conversation.id}`;

    const watcher = await asPerson('bob');
    await watcher.goto(path);
    await shellReady(watcher);
    const heading = watcher.getByRole('banner').or(watcher.locator('header')).first();
    await expect(heading).not.toContainText('local time');

    await signIn('alice');
    await page.goto(`/w/${slug}`);
    await shellReady(page);
    await openNav(page);
    await page.getByRole('button', { name: /^Account:/ }).click();
    await page.getByRole('menuitem', { name: 'Your profile…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Your profile' });
    await dialog.getByRole('textbox', { name: 'Title' }).fill('Platform lead');
    await dialog.getByRole('textbox', { name: 'Status' }).fill('On call this week');
    await dialog.getByRole('combobox', { name: 'Time zone' }).fill('Asia/Tokyo');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Saved.');

    // Told by the socket, read again: no reload on Bob's side.
    await expect(watcher.locator('header').first()).toContainText('local time');
    await expect(watcher.locator('header').first()).toContainText('On call this week', {
      ignoreCase: false,
    });
    await watcher.getByRole('button', { name: /profile$/ }).click();
    const panel = watcher.getByRole('complementary', { name: /^Profile/ });
    await expect(panel).toContainText('Platform lead');
    await expect(panel).toContainText('Asia/Tokyo');
  });
});
