/**
 * The inbox, end to end (D-106): a mention written through the API reaches the person's inbox,
 * opening it takes them to the channel, and the server has it read — the real route, the real
 * database, the real page.
 *
 * Each test makes a room of its own (`support.ts`), because specs in a project run in parallel
 * against one world, and the words carry the room's name so another spec's row is never the one
 * found.
 */
import { expect, test } from './fixtures';
import { railLink, shellReady } from './support';

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
    // Not the room itself: the mention is at its bottom, and leaving a channel reads what the
    // person reached there (`use-mark-read.ts`) — so starting in the room read the mention on the
    // way to the inbox, and whether the row still said unread was a race between that request
    // and the inbox's own.
    await page.goto(`/w/${tenant.slug}/questions`);
    await shellReady(page);
    await (await railLink(page, 'Inbox')).click();
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
