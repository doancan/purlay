/**
 * The inbox, end to end (D-106): a mention written through the API reaches the person's inbox,
 * opening it takes them to the channel, and the server has it read — the real route, the real
 * database, the real page.
 *
 * Each test makes a room of its own (`support.ts`): the four projects share one database, and the
 * words carry the room's name so a row from another project's run is never the one found.
 */
import { expect, test } from './fixtures';
import { navLink, shellReady } from './support';

test.describe('the inbox', () => {
  test('a mention is in it; opening it goes to the channel and reads it', async ({
    page,
    signIn,
    room,
    tenant,
    api,
    expectNoAxe,
  }) => {
    const made = await room({ members: ['dogancan', 'carol'] });
    const words = `@dogancan please look at ${made.name}`;
    await api('carol').say(made.id, words);

    await signIn();
    await page.goto(`/w/${tenant.slug}/c/${made.id}`);
    await shellReady(page);
    await (await navLink(page, 'Inbox')).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();

    const row = page.getByRole('button', { name: new RegExp(made.name) });
    await expect(row).toContainText('carol mentioned you');
    await expect(row).toContainText('unread');
    await expectNoAxe();

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/c/${made.id}$`));
    // Read on the server, not only on this screen.
    const viewer = api('dogancan');
    await expect
      .poll(async () => {
        const unread: { data: { message: { content: string } }[] } = await viewer.get(
          `/api/notifications?workspaceId=${tenant.workspaceId}&unreadOnly=true&limit=100`,
        );
        return unread.data.some((n) => n.message.content === words);
      })
      .toBe(false);
  });
});
