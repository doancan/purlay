/**
 * A group conversation, the whole way (D-127): started from New message in the sidebar, named by
 * its people, written in, and read by another of its people over the API.
 *
 * In a workspace of the test's own — Bob makes it and invites Alice and Carol — so the seeded
 * workspace, which the screenshots draw, gets no conversation.
 */
import { expect, test } from './fixtures';
import { apiAs, openNav, shellReady } from './support';

test.describe('a group conversation', () => {
  test('is started from New message, named by its people, and read by them', async ({
    page,
    signIn,
    tenant,
  }) => {
    const bob = apiAs(tenant, 'bob');
    const slug = `group-${crypto.randomUUID().slice(0, 8)}`;
    const workspace = await bob.post<{ id: string }>('/api/workspaces', { name: 'Group', slug });
    for (const persona of ['alice', 'carol'] as const) {
      const { token } = await bob.post<{ token: string }>(
        `/api/workspaces/${workspace.id}/invitations`,
      );
      await apiAs(tenant, persona).post('/api/invitations/accept', { token });
    }

    await signIn('alice');
    await page.goto(`/w/${slug}`);
    await shellReady(page);
    await openNav(page);
    await page.getByRole('button', { name: 'New message' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^Pick Bob/ }).click();
    await dialog.getByRole('button', { name: /^Pick Carol/ }).click();
    await expect(dialog).toContainText('To: Bob');
    await dialog.getByRole('button', { name: 'Start conversation' }).click();

    await expect(page).toHaveURL(new RegExp(`/w/${slug}/c/[0-9a-f-]{36}$`));
    const channelId = page.url().split('/').at(-1) ?? '';
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /Bob.*, .*Carol|Carol.*, .*Bob/,
    );

    // Its title opens its details: its people, and a way to more of them.
    await page.getByRole('heading', { level: 1 }).getByRole('button').click();
    const details = page.getByRole('dialog');
    await expect(details.getByRole('listitem')).toHaveCount(3);
    await expect(
      details.getByRole('button', { name: 'New conversation with these people…' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();

    const words = `shipping at five ${crypto.randomUUID().slice(0, 6)}`;
    const composer = page.getByRole('textbox', { name: /^Message/ });
    await composer.fill(words);
    await composer.press('Enter');
    await expect(page.getByText(words)).toBeVisible();

    await expect
      .poll(async () => {
        const read = await bob.get<{ data: { content: string }[] }>(
          `/api/channels/${channelId}/messages`,
        );
        return read.data.some((message) => message.content === words);
      })
      .toBe(true);
    const carolSees = await apiAs(tenant, 'carol').get<{ id: string; peers: unknown[] }[]>(
      `/api/workspaces/${workspace.id}/channels`,
    );
    expect(carolSees.find((channel) => channel.id === channelId)?.peers).toHaveLength(2);
  });
});
