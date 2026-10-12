/**
 * An invitation, the whole way (D-115): a link made over the API, opened by somebody not signed in,
 * carried through sign-in in the tab — never in the address after the page loads — and joined.
 *
 * Carol joins, in a workspace made for the test, so nobody else's screens gain a workspace.
 */
import { expect, test } from './fixtures';
import { apiAs } from './support';

test.describe('an invitation', () => {
  test('opened signed out, survives signing in, and joins the workspace it names', async ({
    page,
    signIn,
    tenant,
  }) => {
    const alice = apiAs(tenant, 'alice');
    const slug = `invited-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await alice.post<{ id: string }>('/api/workspaces', {
      name: 'Invited',
      slug,
    });
    const { token } = await alice.post<{ token: string }>(
      `/api/workspaces/${workspace.id}/invitations`,
    );

    await page.goto(`/invite#${token}`);
    // Not signed in: sent to sign in, and the secret is already out of the address.
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(page.url()).not.toContain(token);

    // Signing in comes back to the root, as GitHub's callback does, in the same tab.
    await signIn('carol');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Join Invited' })).toBeVisible();
    expect(page.url()).not.toContain(token);

    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
    const memberships = await apiAs(tenant, 'carol').get<{ workspace: { id: string } }[]>(
      '/api/workspaces',
    );
    expect(memberships.map((m) => m.workspace.id)).toContain(workspace.id);
  });
});
