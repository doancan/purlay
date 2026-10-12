/**
 * An invitation, the whole way (D-115): a link made over the API, opened by somebody not signed in,
 * carried through sign-in in the tab — never in the address after the page loads — and joined.
 *
 * Bob, who writes through the API (`support.ts`), makes the workspace and the link; Alice, a person
 * the tests drive through the page, joins it. Its link-preview and join are writes on her budget, as
 * a page's are; the screens that show her workspaces take no screenshot.
 */
import { expect, test } from './fixtures';
import { apiAs, openNav } from './support';

test.describe('an invitation', () => {
  test('opened signed out, survives signing in, and joins the workspace it names', async ({
    page,
    signIn,
    tenant,
  }) => {
    const bob = apiAs(tenant, 'bob');
    const slug = `invited-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await bob.post<{ id: string }>('/api/workspaces', {
      name: 'Invited',
      slug,
    });
    const { token } = await bob.post<{ token: string }>(
      `/api/workspaces/${workspace.id}/invitations`,
    );

    await page.goto(`/invite#${token}`);
    // Not signed in: sent to sign in, and the secret is already out of the address.
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(page.url()).not.toContain(token);

    // Signing in comes back to the root, as GitHub's callback does, in the same tab.
    await signIn('alice');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Join Invited' })).toBeVisible();
    expect(page.url()).not.toContain(token);

    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}`));
    const memberships = await apiAs(tenant, 'alice').get<{ workspace: { id: string } }[]>(
      '/api/workspaces',
    );
    expect(memberships.map((m) => m.workspace.id)).toContain(workspace.id);
  });

  test('made by an owner from the workspace menu, and opened by the person it was sent to', async ({
    page,
    signIn,
    tenant,
    asPerson,
  }) => {
    await signIn();
    await page.goto(`/w/${tenant.slug}`);
    // Behind the navigation's toggle at a narrow width, in place at a wide one.
    await openNav(page);
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page.getByRole('menuitem', { name: 'Invite people…' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Make a link' }).click();
    const field = dialog.getByRole('textbox', { name: 'Invitation link' });
    await expect(field).toHaveValue(/\/invite#[0-9a-f]{64}$/);
    const link = await field.inputValue();

    // Alice is in the workspace already: the link offers to open it, and joins nothing.
    const alice = await asPerson('alice');
    await alice.goto(new URL(link).pathname + new URL(link).hash);
    await expect(alice.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
  });
});
