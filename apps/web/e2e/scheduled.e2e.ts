/**
 * Send later, the whole way (D-314): a message scheduled from the box in a real browser, found in the
 * Scheduled tab, cancelled or edited back into the draft — the server holding all of it, and read back
 * through the API as a second witness.
 *
 * In a workspace of the test's own — Bob makes it and invites Alice — so the seeded workspace gets no
 * scheduled messages. Nothing here waits for a time to come: a message is scheduled an hour or more
 * ahead, looked at and taken back.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { apiAs, shellReady, wallClock } from './support';

interface Scheduled {
  readonly id: string;
  readonly channelId: string;
  readonly parentId: string | null;
  readonly content: string;
  readonly sendAt: string;
  readonly state: string;
}

const HOUR_MS = 3_600_000;

/** Bob's workspace with Alice in it and one channel, `ops`, which both are in. */
const workspaceWithAlice = async (
  tenant: Parameters<typeof apiAs>[0],
): Promise<{
  readonly id: string;
  readonly slug: string;
  readonly channelId: string;
  readonly list: () => Promise<readonly Scheduled[]>;
}> => {
  const bob = apiAs(tenant, 'bob');
  const alice = apiAs(tenant, 'alice');
  const slug = `later-${crypto.randomUUID().slice(0, 8)}`;
  const workspace = await bob.post<{ id: string }>('/api/workspaces', { name: 'Later', slug });
  const { token } = await bob.post<{ token: string }>(
    `/api/workspaces/${workspace.id}/invitations`,
  );
  await alice.post('/api/invitations/accept', { token });
  const channel = await bob.post<{ id: string }>(`/api/workspaces/${workspace.id}/channels`, {
    name: 'ops',
  });
  await alice.post(`/api/channels/${channel.id}/join`);
  return {
    id: workspace.id,
    slug,
    channelId: channel.id,
    list: () => alice.get<Scheduled[]>(`/api/workspaces/${workspace.id}/scheduled`),
  };
};

const writeInBox = async (page: Page, words: string): Promise<void> => {
  const box = page.getByRole('textbox', { name: 'Message ops' });
  await box.fill(words);
  await expect(box).toHaveText(words);
};

test.describe('send later', () => {
  test('a message scheduled for in an hour is held by the server, listed, and cancelled', async ({
    page,
    signIn,
    tenant,
  }) => {
    const world = await workspaceWithAlice(tenant);
    const words = `later please ${crypto.randomUUID().slice(0, 6)}`;
    await signIn('alice');
    await page.goto(`/w/${world.slug}/c/${world.channelId}`);
    await shellReady(page);
    await writeInBox(page, words);
    const asked = wallClock().getTime();

    await page.getByRole('button', { name: 'Send later' }).click();
    await page.getByRole('menuitem', { name: 'In 1 hour' }).click();
    // The toast says when, and the box is empty as after a send.
    // An hour on is the next day from 23:00 in the page's zone (UTC, the projects'), and the toast says so: the
    // word is the one the press's own instant calls for, so the test means the same at every hour (#1508). Within
    // a minute of the midnight either is right.
    const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
    const early = dayOf(asked + HOUR_MS);
    const late = dayOf(asked + HOUR_MS + 60_000);
    const day = early !== late ? '(Today|Tomorrow)' : early === dayOf(asked) ? 'Today' : 'Tomorrow';
    await expect(
      page.getByText(new RegExp(`^Scheduled for ${day} at \\d\\d:\\d\\d$`)),
    ).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Message ops' })).toHaveText('');

    // The server holds it, an hour from the press, and nothing was sent to the channel.
    const held = await world.list();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ content: words, state: 'pending', parentId: null });
    const sendAt = Date.parse(held[0]?.sendAt ?? '');
    expect(sendAt).toBeGreaterThan(asked + HOUR_MS - 60_000);
    expect(sendAt).toBeLessThan(wallClock().getTime() + HOUR_MS + 60_000);
    await expect(page.locator('[data-message-row]', { hasText: words })).toHaveCount(0);

    // View scheduled opens the tab, which counts it and shows it.
    await page.getByRole('button', { name: 'View scheduled' }).click();
    await expect(page).toHaveURL(new RegExp(`/w/${world.slug}/drafts\\?tab=scheduled`));
    const main = page.getByRole('main');
    await expect(main.getByRole('button', { name: 'Scheduled (1)' })).toBeVisible();
    await expect(main.getByText(words)).toBeVisible();
    await expect(main.getByText('ops', { exact: true })).toBeVisible();

    // Cancelling takes it from the list and from the server, and Undo is offered.
    await main.getByRole('button', { name: 'Cancel scheduled message' }).click();
    await expect(page.getByText('Scheduled message cancelled')).toBeVisible();
    await expect(main.getByText(words)).toBeHidden();
    await expect(main.getByText('Nothing scheduled')).toBeVisible();
    expect(await world.list()).toEqual([]);
  });

  test('Send now sends a scheduled message at once: it leaves the list and is in the channel', async ({
    page,
    signIn,
    tenant,
  }) => {
    const world = await workspaceWithAlice(tenant);
    const words = `şimdi gönder ${crypto.randomUUID().slice(0, 6)}`;
    await signIn('alice');
    await page.goto(`/w/${world.slug}/c/${world.channelId}`);
    await shellReady(page);
    await writeInBox(page, words);
    await page.getByRole('button', { name: 'Send later' }).click();
    await page.getByRole('menuitem', { name: 'Tomorrow at 09:00' }).click();
    await expect(page.getByText(/^Scheduled for Tomorrow at 09:00$/)).toBeVisible();
    const [held] = await world.list();
    await expect(page.locator('[data-message-row]', { hasText: words })).toHaveCount(0);

    await page.getByRole('button', { name: 'View scheduled' }).click();
    const main = page.getByRole('main');
    await expect(main.getByText(words)).toBeVisible();
    const asked = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/scheduled/${held?.id ?? ''}/send`),
    );
    await main.getByRole('button', { name: 'Send now' }).click();
    expect((await asked).status()).toBe(200);
    await expect(page.getByText('Sent in ops.')).toBeVisible();
    await expect(main.getByText('Nothing scheduled')).toBeVisible();

    // The server agrees from its side: nothing is waiting, and the channel has the message, a new id.
    expect(await world.list()).toEqual([]);
    const history = await apiAs(tenant, 'bob').get<{
      data: readonly { id: string; content: string }[];
    }>(`/api/channels/${world.channelId}/messages`);
    const sent = history.data.filter((message) => message.content === words);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).not.toBe(held?.id);

    // And the feed shows it, once.
    await page.goto(`/w/${world.slug}/c/${world.channelId}`);
    await shellReady(page);
    await expect(page.locator('[data-message-row]', { hasText: words })).toHaveCount(1);
  });

  test('Undo after Cancel puts the same message back under the same id', async ({
    page,
    signIn,
    tenant,
  }) => {
    const world = await workspaceWithAlice(tenant);
    const words = `undo me ${crypto.randomUUID().slice(0, 6)}`;
    await signIn('alice');
    await page.goto(`/w/${world.slug}/c/${world.channelId}`);
    await shellReady(page);
    await writeInBox(page, words);
    await page.getByRole('button', { name: 'Send later' }).click();
    await page.getByRole('menuitem', { name: 'Tomorrow at 09:00' }).click();
    await expect(page.getByText(/^Scheduled for Tomorrow at 09:00$/)).toBeVisible();
    const [before] = await world.list();

    await page.getByRole('button', { name: 'View scheduled' }).click();
    const main = page.getByRole('main');
    await main.getByRole('button', { name: 'Cancel scheduled message' }).click();
    await expect(main.getByText('Nothing scheduled')).toBeVisible();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(main.getByText(words)).toBeVisible();
    const [after] = await world.list();
    expect(after).toMatchObject({ id: before?.id, content: words, sendAt: before?.sendAt });

    await main.getByRole('button', { name: 'Cancel scheduled message' }).click();
    await expect(main.getByText('Nothing scheduled')).toBeVisible();
    expect(await world.list()).toEqual([]);
  });

  test('any time from the dialog, in the viewer’s zone, and a time out of range is explained', async ({
    page,
    signIn,
    tenant,
  }) => {
    const world = await workspaceWithAlice(tenant);
    const words = `on a day ${crypto.randomUUID().slice(0, 6)}`;
    await signIn('alice');
    await page.goto(`/w/${world.slug}/c/${world.channelId}`);
    await shellReady(page);
    await writeInBox(page, words);
    await page.getByRole('button', { name: 'Send later' }).click();
    await page.getByRole('menuitem', { name: 'Pick date and time…' }).click();
    const field = page.getByLabel('Date and time');
    await expect(field).toBeVisible();

    // A time in the past is said in place, and nothing is asked of the server.
    await field.fill('2020-01-01T09:00');
    await expect(page.getByRole('alert')).toHaveText('Choose a time at least a minute from now.');
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(field).toBeVisible();
    expect(await world.list()).toEqual([]);

    // Three days ahead at 18:30 where the browser is: the field's wall clock, the server's instant.
    const { typed, instant } = await page.evaluate((now) => {
      const day = new Date(now + 3 * 24 * 3_600_000);
      const pad = (value: number): string => String(value).padStart(2, '0');
      const local = `${String(day.getFullYear())}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}T18:30`;
      return { typed: local, instant: new Date(local).toISOString() };
    }, wallClock().getTime());
    await field.fill(typed);
    await expect(page.getByText(/^Sends .* at 18:30\.$/)).toBeVisible();
    await page.getByRole('button', { name: 'Schedule', exact: true }).click();
    await expect(page.getByText(/^Scheduled for .* at 18:30$/)).toBeVisible();

    const [held] = await world.list();
    expect(held?.sendAt).toBe(instant);
    expect(held?.content).toBe(words);
    await apiAs(tenant, 'alice').del(
      `/api/channels/${world.channelId}/scheduled/${held?.id ?? ''}`,
    );
  });

  test('a reply scheduled from a thread’s box goes to that thread, and Edit puts it back in the thread’s draft', async ({
    page,
    signIn,
    tenant,
  }) => {
    const world = await workspaceWithAlice(tenant);
    const root = await apiAs(tenant, 'bob').say(world.channelId, 'a root to answer');
    const words = `answer later ${crypto.randomUUID().slice(0, 6)}`;
    await signIn('alice');
    await page.goto(`/w/${world.slug}/c/${world.channelId}?thread=${root.id}`);
    await shellReady(page);
    const panel = page.getByRole('complementary', { name: 'Thread · #ops' });
    const reply = panel.getByRole('textbox');
    await reply.fill(words);
    await panel.getByRole('button', { name: 'Send later' }).click();
    await page.getByRole('menuitem', { name: 'In 1 hour' }).click();
    await expect(page.getByText(/^Scheduled for /)).toBeVisible();
    const [held] = await world.list();
    expect(held).toMatchObject({ content: words, parentId: root.id });

    await page.getByRole('button', { name: 'View scheduled' }).click();
    const main = page.getByRole('main');
    await expect(main.getByText('· in a thread')).toBeVisible();
    await main.getByRole('button', { name: 'Edit scheduled message' }).click();

    // One step: it is no longer scheduled, and the thread opens with the words in its box.
    await expect(page.getByText(/no longer scheduled\.$/)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`\\?thread=${root.id}`));
    await expect(panel.getByRole('textbox')).toHaveText(words);
    expect(await world.list()).toEqual([]);
  });

  test('on a phone the date and time field is 16px, so the page does not zoom, and the tab opens by its address', async ({
    page,
    signIn,
    tenant,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    const world = await workspaceWithAlice(tenant);
    const words = `phone ${crypto.randomUUID().slice(0, 6)}`;
    await signIn('alice');
    await page.goto(`/w/${world.slug}/c/${world.channelId}`);
    await shellReady(page);
    await writeInBox(page, words);
    await page.getByRole('button', { name: 'Send later' }).click();
    await page.getByRole('menuitem', { name: 'Pick date and time…' }).click();
    const size = await page
      .getByLabel('Date and time')
      .evaluate((element) => getComputedStyle(element).fontSize);
    expect(size).toBe('16px');
    await page.keyboard.press('Escape');
    await page.goto(`/w/${world.slug}/drafts?tab=scheduled`);
    await expect(page.getByRole('main').getByText('Nothing scheduled')).toBeVisible();
  });
});
