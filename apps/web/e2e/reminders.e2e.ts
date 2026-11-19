/**
 * Message reminders, the whole way: "Remind me…" in a message's More menu in a real browser, the mark on
 * the message, the Reminders tab of Saved, removed from there — the server's list checked beside each
 * step — and a reminder that falls due arriving in the Inbox and opening on its message.
 *
 * A room of the test's own (`support.ts`): specs run in parallel against one world, and the words carry the
 * room's name so another spec's message is never the one found.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { isNarrow, openNav, railLink, shellReady } from './support';

interface Reminders {
  readonly message: { readonly id: string };
  readonly remindAt: string;
}

/** How long the API's delivery loop, which looks every 15 seconds, may take to bring a due reminder in. */
const DUE_WITHIN_MS = 45_000;

/** The server's own clock, from the `Date` header of its answer: it is what judges a reminder's time. */
/**
 * Chooses an item of the submenu that is open, the way a hand does: the pointer travels there over several
 * moves. The browser tests' pointer otherwise jumps in one step, which leaves no path through the submenu's
 * pointer-grace area, and WebKit then closes the submenu before the click lands (measured: three of eight
 * runs sent no request at all).
 */
const chooseInSubmenu = async (page: Page, name: string): Promise<void> => {
  const item = page.getByRole('menuitem', { name });
  await expect(item).toBeVisible();
  const box = await item.boundingBox();
  if (box === null) throw new Error(`the submenu item ${name} has no box to point at`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
  await item.click();
};

const serverNow = async (baseURL: string): Promise<number> => {
  const stamp = (await fetch(`${baseURL}/health`)).headers.get('date');
  expect(stamp, 'the server answers with a Date header').toBeTruthy();
  return Date.parse(stamp ?? '');
};

test.describe('message reminders', () => {
  test('set from the menu, marked on the message, listed in Saved, and removed', async ({
    page,
    signIn,
    room,
    tenant,
    api,
  }) => {
    const made = await room({ members: ['dogancan', 'carol'] });
    const words = `ask about the rollout in ${made.name}`;
    const message = await api('carol').say(made.id, words);
    const viewer = api('dogancan');
    // The person's reminders in a workspace the whole project shares: this message's alone are asked about.
    const listed = async (): Promise<Reminders[]> =>
      (await viewer.get<Reminders[]>(`/api/workspaces/${tenant.workspaceId}/reminders`)).filter(
        (one) => one.message.id === message.id,
      );

    await signIn();
    await page.goto(`/w/${tenant.slug}/c/${made.id}`);
    await shellReady(page);
    const row = page.locator(`[data-message-id="${message.id}"]`);
    await row.hover();
    await row.getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Remind me…' }).click();
    await chooseInSubmenu(page, 'In 1 hour');

    const mark = row.locator('[data-reminder-mark]');
    await expect(mark).toBeVisible();
    await expect(mark).toHaveText(/^Reminder: /);
    // The server has it, an hour ahead as asked.
    await expect.poll(async () => (await listed()).length).toBe(1);
    const [held] = await listed();
    const ahead = new Date(held?.remindAt ?? 0).getTime() - (await serverNow(tenant.baseURL));
    expect(ahead).toBeGreaterThan(55 * 60_000);
    expect(ahead).toBeLessThan(65 * 60_000);

    await page.goto(`/w/${tenant.slug}/saved`);
    await shellReady(page);
    const main = page.getByRole('main');
    await main.getByRole('button', { name: /^Reminders \(\d+\)$/ }).click();
    await expect(page).toHaveURL(/\?state=reminders$/);
    await expect(main.getByText(words)).toBeVisible();
    await main
      .getByRole('listitem')
      .filter({ hasText: words })
      .getByRole('button', { name: 'Remove reminder' })
      .click();
    await expect(main.getByText(words)).toBeHidden();
    await expect.poll(listed).toEqual([]);
  });

  test('a reminder that falls due is in the Inbox, and opens on its message', async ({
    page,
    signIn,
    room,
    tenant,
    api,
    expectNoAxe,
  }) => {
    test.setTimeout(DUE_WITHIN_MS + 60_000);
    const made = await room({ members: ['dogancan', 'carol'] });
    const words = `the deploy window closes soon in ${made.name}`;
    const message = await api('carol').say(made.id, words);
    // Eight seconds ahead: the least the server takes is five, and its clock is read to the second.
    await api('dogancan').put(`/api/messages/${message.id}/reminder`, {
      remindAt: new Date((await serverNow(tenant.baseURL)) + 8_000).toISOString(),
    });

    await signIn();
    await page.goto(`/w/${tenant.slug}/questions`);
    await shellReady(page);
    if (isNarrow(page)) {
      await (await railLink(page, 'Inbox')).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
    } else {
      await openNav(page);
      await page
        .getByRole('navigation', { name: 'Places' })
        .getByRole('button', { name: /^Inbox/ })
        .click();
      await expect(page.getByRole('dialog', { name: 'Inbox' })).toBeVisible();
    }
    const item = page.getByRole('button', { name: new RegExp(made.name) });
    await expect(item).toContainText('Your message reminder is due', { timeout: DUE_WITHIN_MS });
    // The reminded message is quoted, and the reminder is spent.
    await expect(item).toContainText(words);
    await expectNoAxe();
    expect(
      (
        await api('dogancan').get<Reminders[]>(`/api/workspaces/${tenant.workspaceId}/reminders`)
      ).filter((one) => one.message.id === message.id),
    ).toEqual([]);

    await item.click();
    // The message is where the person lands, marked as the address's own (`permalinks.e2e.ts`).
    await expect(page).toHaveURL(new RegExp(`/c/${made.id}(\\?message=${message.id})?$`));
    const landed = page.locator(`[data-message-id="${message.id}"]`);
    await expect(landed).toBeInViewport();
    await expect(landed).toHaveAttribute('data-landed', '');
  });
});
