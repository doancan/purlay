/**
 * Profiles, the whole way (#488, D-131): Alice sets her title, time zone and status from the account
 * menu, and Bob — in a conversation with her, already open — sees the time where she is and her
 * status in its heading, and her profile beside it, without reloading: her change told his tab to
 * read the members again.
 *
 * In a workspace of the test's own, so the seeded people, which the screenshots draw, keep theirs.
 */
import { expect, test } from './fixtures';
import { apiAs, isNarrow, openNav, shellReady } from './support';

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
    await signIn('alice');
    await page.goto(`/w/${slug}`);
    await shellReady(page);
    await openNav(page);
    await page.getByRole('button', { name: /^Account:/ }).click();
    // Settings opens on the person's Profile page (D-146).
    await page.getByRole('menuitem', { name: /^Settings/ }).click();
    const form = page.getByRole('main');
    await expect(form.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
    await form.getByRole('textbox', { name: 'Title' }).fill('Platform lead');
    await form.getByRole('textbox', { name: 'Status' }).fill('On call this week');
    await form.getByRole('combobox', { name: 'Time zone' }).fill('Asia/Tokyo');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');

    // Told by the socket, read again: no reload on Bob's side. On a wide window the time and status
    // are beside her name; on a narrow one there is no room, and her profile says them.
    const header = watcher.locator('header').first();
    if (isNarrow(watcher)) {
      await expect(header.getByText('local time')).toBeHidden();
    } else {
      await expect(header.getByText(/local time$/)).toBeVisible();
      await expect(header.getByText('On call this week')).toBeVisible();
    }
    await watcher.getByRole('heading', { level: 1 }).getByRole('button').click();
    const panel = watcher.getByRole('complementary', { name: /^Profile/ });
    await expect(panel.getByText('Platform lead')).toBeVisible();
    await expect(panel.getByText(/local time$/)).toBeVisible();
    await expect(panel.getByText('Asia/Tokyo')).toBeVisible();
  });
});
