/**
 * An invitation, the whole way (D-115): a link made over the API, opened by somebody not signed in,
 * carried through sign-in in the tab — never in the address after the page loads — and joined.
 *
 * Bob, who writes through the API (`support.ts`), makes the workspace and the link; Alice, a person
 * the tests drive through the page, joins it. Its link-preview and join are writes on her budget, as
 * a page's are; the screens that show her workspaces take no screenshot.
 */
import { expect, test } from './fixtures';
import { apiAs, openNav, openSettings } from './support';

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
    // Two channels to join: one where the conversation is, one nobody has written in.
    const busy = await bob.post<{ id: string }>(`/api/workspaces/${workspace.id}/channels`, {
      name: 'deploys',
    });
    await bob.post(`/api/workspaces/${workspace.id}/channels`, { name: 'quiet' });
    await bob.say(busy.id, 'shipping now');

    await page.goto(`/invite#${token}`);
    // Not signed in: the page is a way in (the passport comes before GitHub or a link), and the
    // secret is already out of the address.
    await expect(page).toHaveURL(/\/invite$/);
    await expect(page.getByRole('heading', { name: 'You have been invited' })).toBeVisible();
    expect(page.url()).not.toContain(token);

    // Signing in comes back to the root, as GitHub's callback does, in the same tab.
    await signIn('alice');
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Join Invited' })).toBeVisible();
    expect(page.url()).not.toContain(token);

    await page.getByRole('button', { name: 'Join' }).click();
    // Joined: the channels to join come first, the busy one picked, the silent one not (D-132).
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/welcome$`));
    await expect(page.getByRole('checkbox', { name: '#deploys' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: '#quiet' })).not.toBeChecked();
    await page.getByRole('button', { name: 'Join 1 channel' }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${slug}/c/${busy.id}`));
    const alice = apiAs(tenant, 'alice');
    const memberships = await alice.get<{ workspace: { id: string } }[]>('/api/workspaces');
    expect(memberships.map((m) => m.workspace.id)).toContain(workspace.id);
    const channels = await alice.get<{ name: string | null; state: unknown }[]>(
      `/api/workspaces/${workspace.id}/channels`,
    );
    expect(channels.filter((c) => c.state !== null).map((c) => c.name)).toContain('deploys');
    expect(channels.find((c) => c.name === 'quiet')?.state).toBeNull();
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
    const dialog = page.getByRole('dialog', { name: /^Invite people to / });
    await dialog.getByRole('button', { name: 'Make a link' }).click();
    const field = dialog.getByRole('textbox', { name: 'Invitation link' });
    await expect(field).toHaveValue(/\/invite#[0-9a-f]{64}$/);
    const link = await field.inputValue();

    // The open links are the Invitations page's (D-146), a press away from the dialog.
    await dialog.getByRole('link', { name: 'See and revoke open links' }).click();
    await expect(dialog).toHaveCount(0);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Invitations' })).toBeVisible();
    // Each open link is said whole, at either width: its end is the time, and a cut "11:22 …" hides
    // whether it is morning or night.
    const rows = main.locator('li [id^="invitation-"]');
    await expect(rows.first()).toBeVisible();
    for (const row of await rows.all()) {
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true,
      );
    }

    // Alice is in the workspace already: the link offers to open it, and joins nothing.
    const alice = await asPerson('alice');
    await alice.goto(new URL(link).pathname + new URL(link).hash);
    await expect(alice.getByRole('button', { name: 'Open', exact: true })).toBeVisible();
  });

  test('by email: chips, a wrong address kept red, the server’s answer said in words, and the link always there', async ({
    page,
    signIn,
    tenant,
  }) => {
    // The e2e server has no mail relay, so the screen is told there is one — the way a configured
    // server tells it — and the real server then answers what it does without one: every address
    // `unavailable`, the link made all the same. The queued answer has no relay to stand on here and
    // is the integration tests' (`invitation-mail.integration.test.ts`).
    await page.route('**/api/auth/methods', async (route) => {
      await route.fulfill({
        json: { github: true, email: true, oidc: null, signUp: 'invite-only', password: true },
      });
    });
    await signIn();
    await page.goto(`/w/${tenant.slug}`);
    await openNav(page);
    await page.getByRole('button', { name: 'Switch workspace' }).click();
    await page.getByRole('menuitem', { name: 'Invite people…' }).click();
    const dialog = page.getByRole('dialog', { name: /^Invite people to / });
    const field = dialog.getByRole('textbox', { name: 'Email addresses' });
    await expect(field).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Send invitations' })).toBeDisabled();

    await field.fill('ann@example.test,nope,');
    await field.press('Enter');
    await expect(dialog.getByText('ann@example.test')).toBeVisible();
    await expect(dialog.getByText('(not an email address)')).toBeAttached();
    // The dialog fits the window at both widths: nothing runs off its edge.
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );

    await dialog.getByRole('button', { name: 'Send invitation' }).click();
    await expect(
      dialog.getByText('This server cannot send email, so these were not sent: ann@example.test.'),
    ).toBeVisible();
    // Never said to be sent; the link is there to copy, and the refused address stays in the field.
    await expect(dialog.getByText(/Asked the mail server/)).toHaveCount(0);
    await expect(dialog.getByRole('textbox', { name: 'Invitation link' })).toHaveValue(
      /\/invite#[0-9a-f]{64}$/,
    );
    await expect(dialog.getByRole('button', { name: 'Remove nope' })).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
  });

  test('an open link is revoked on the Invitations page, and opens for nobody after', async ({
    page,
    signIn,
    tenant,
    newcomer,
  }) => {
    // A workspace of its own: every open link in it is revoked below, and in the shared one that
    // would end the links the other tests here are in the middle of opening. Bob makes it and makes
    // Alice an admin, so she may see its links; the page is hers.
    const bob = apiAs(tenant, 'bob');
    const slug = `revoked-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await bob.post<{ id: string }>('/api/workspaces', {
      name: 'Revoked',
      slug,
    });
    const welcome = await bob.post<{ token: string }>(
      `/api/workspaces/${workspace.id}/invitations`,
    );
    const alice = apiAs(tenant, 'alice');
    await alice.post('/api/invitations/accept', { token: welcome.token });
    const me = await alice.get<{ user: { id: string } }>('/api/me');
    await bob.patch(`/api/workspaces/${workspace.id}/members/${me.user.id}`, { role: 'admin' });
    const { token } = await bob.post<{ token: string }>(
      `/api/workspaces/${workspace.id}/invitations`,
    );

    await signIn('alice');
    const main = await openSettings(page, slug, 'invitations', 'Invitations');
    const revoke = main.getByRole('button', { name: 'Revoke' });
    // Every open link is ended, the one made above among them.
    await expect(revoke).toHaveCount(2);
    for (let open = 2; open > 0; open -= 1) {
      await revoke.first().click();
      await expect(revoke).toHaveCount(open - 1);
    }
    await expect(main.getByText('No links are open.')).toBeVisible();

    // Somebody of the test's own opens it: the preview is a write on their budget, and carol's — the
    // person every room of the run is made by (`support.ts`) — was spent by the time she got here.
    const stranger = await (await newcomer('stranger')).page();
    await stranger.goto(`/invite#${token}`);
    await expect(stranger.getByText('This invitation does not open')).toBeVisible();
  });
});
