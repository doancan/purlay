/**
 * Starred channels, the whole way (#489, D-132): Alice stars a channel from its header, it moves
 * into Starred above Channels, and her other tab — already open — follows without reloading.
 *
 * In a workspace of the test's own, so the seeded one, which the screenshots draw, keeps no star.
 */
import { expect, test } from './fixtures';
import { apiAs, isNarrow, openNav, shellReady } from './support';

test.describe('starred channels', () => {
  test('starred in one tab, kept above the rest there and in the other', async ({
    page,
    signIn,
    tenant,
    asPerson,
  }) => {
    const alice = apiAs(tenant, 'alice');
    const slug = `starred-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await alice.post<{ id: string }>('/api/workspaces', { name: 'Stars', slug });
    const channel = await alice.post<{ id: string }>(`/api/workspaces/${workspace.id}/channels`, {
      name: 'runbooks',
    });
    const path = `/w/${slug}/c/${channel.id}`;

    const other = await asPerson('alice');
    await other.goto(`/w/${slug}`);
    await shellReady(other);

    await signIn('alice');
    await page.goto(path);
    await shellReady(page);
    // On a narrow window the star is in the header's menu, with the panels.
    if (isNarrow(page)) {
      await page.getByRole('button', { name: 'Channel menu' }).click();
      await page.getByRole('menuitem', { name: 'Star this channel' }).click();
    } else {
      const star = page.getByRole('button', { name: 'Star this channel' });
      await star.click();
      await expect(star).toHaveAttribute('aria-pressed', 'true');
    }
    const starred = (await openNav(page)).getByRole('navigation', { name: 'Starred' });
    await expect(starred.getByRole('link', { name: /runbooks/ })).toBeVisible();

    // Told by the socket, read again: no reload in the other tab.
    const there = (await openNav(other)).getByRole('navigation', { name: 'Starred' });
    await expect(there.getByRole('link', { name: /runbooks/ })).toBeVisible();
    expect(
      (
        await alice.get<{ id: string; starred: boolean }[]>(
          `/api/workspaces/${workspace.id}/channels`,
        )
      ).find((c) => c.id === channel.id)?.starred,
    ).toBe(true);
  });
});
