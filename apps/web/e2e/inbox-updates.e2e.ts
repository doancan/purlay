/**
 * The inbox's Updates section, end to end (D-286): somebody assigns an issue through the API, the assignee's inbox carries a dot
 * and lists it under Updates in the person's words, opening it reads it on the server and goes to issues, and a second assignment
 * reaches the open page live. The real routes, the real database, the real page, on every engine the suite runs.
 *
 * The people are newcomers in a workspace of their own, so the dot is not on the seeded people's inbox for the other specs.
 */
import { expect, test, workspaceFor } from './fixtures';
import { isNarrow, openNav, railLink, shellReady } from './support';

interface InboxCount {
  readonly unreadCount: number;
}

test.describe('the inbox’s Updates', () => {
  test('an assignment is listed, opening it reads it and goes to issues, and the next one arrives live', async ({
    newcomer,
    expectNoAxe,
  }) => {
    const owner = await newcomer('assigns');
    const reader = await newcomer('assigned');
    const workspace = await workspaceFor(owner, reader);
    const issues = `/api/workspaces/${workspace.id}/issues`;
    await owner.api.post(issues, { title: 'Ship the bus', assigneeId: reader.userId });

    const page = await reader.page();
    await page.goto(`/w/${workspace.slug}`);
    await shellReady(page);

    // The dot says it, in words, before anything is opened.
    const unread = async (): Promise<number> =>
      (
        await reader.api.get<InboxCount>(
          `/api/workspaces/${workspace.id}/inbox?unreadOnly=true&limit=1`,
        )
      ).unreadCount;
    expect(await unread()).toBe(1);
    const inbox = (): ReturnType<typeof page.getByRole> =>
      page.getByRole('navigation', { name: 'Places' }).getByRole('button', { name: /^Inbox/ });
    if (isNarrow(page)) {
      await (await railLink(page, 'Inbox')).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
      await page.getByRole('button', { name: 'Updates' }).click();
    } else {
      await openNav(page);
      await expect(inbox()).toContainText('unread');
      await inbox().click();
      const panel = page.getByRole('dialog', { name: 'Inbox' });
      await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: 'Updates' }).click();
    }

    const row = page.getByRole('button', { name: /assigned an issue to you/ });
    await expect(row).toContainText('unread');
    // The sentence names who, never the title.
    await expect(row).not.toContainText('Ship the bus');
    await expectNoAxe(page.getByRole('list', { name: 'Updates' }));

    await row.click();
    await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/issues$`));
    // Read on the server, not only on this screen.
    await expect.poll(unread).toBe(0);
    if (!isNarrow(page)) {
      await expect(inbox()).not.toContainText('unread');
    }

    // A second assignment, to the open page: told live, the dot is back with no reload.
    await owner.api.post(issues, { title: 'Ship the second', assigneeId: reader.userId });
    await expect.poll(unread).toBe(1);
    if (!isNarrow(page)) {
      await expect(inbox()).toContainText('unread');
    } else {
      await openNav(page);
      await expect(
        page.getByRole('navigation', { name: 'Places' }).getByRole('link', { name: /^Inbox/ }),
      ).toContainText('unread');
    }
  });
});
