/**
 * Where a channel opens, what keeps its place, and when it counts as read (`UX.md` §6, D-98 §5,
 * D-99 §4) — the part of the product that is hardest to get right and that no component test can
 * judge, because it is arithmetic over a layout.
 *
 * Every test makes a room of its own (`support.ts`): reading moves a position on the server,
 * and the four projects share one database.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test, type Persona } from './fixtures';
import { history, navLink, writeInParallel, type ApiClient, type Tenant } from './support';

const PEOPLE: readonly Persona[] = ['dogancan', 'alice', 'bob', 'carol'];

/** The scroll container of the open channel: the feed's parent. */
const scroller = (page: Page): Locator => page.getByRole('feed').locator('..');

/** Message ids of a channel, oldest first, read through the API as the viewer. */
const idsOf = async (viewer: ApiClient, channelId: string): Promise<string[]> => {
  const found: string[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: { id: string }[]; nextCursor: string | null } = await viewer.get(
      `/api/channels/${channelId}/messages?limit=100${cursor === null ? '' : `&before=${cursor}`}`,
    );
    found.push(...page.data.map((m) => m.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  return found.reverse();
};

const roomWithHistory = async (
  tenant: Tenant,
  room: (options: {
    members: readonly Persona[];
  }) => Promise<{ id: string; path: string; name: string }>,
  count: number,
  by?: readonly Persona[],
): Promise<{ id: string; path: string; name: string; ids: string[] }> => {
  const made = await room({ members: PEOPLE });
  await writeInParallel(tenant, made.id, history(count, by));
  return { ...made, ids: [] };
};

/** Where a row is, relative to the visible part of the scroller: both measured in the page. */
const visibleWithin = async (page: Page, target: Locator): Promise<boolean> => {
  const box = await target.boundingBox();
  const frame = await scroller(page).boundingBox();
  if (box === null || frame === null) return false;
  return box.y >= frame.y - 1 && box.y + box.height <= frame.y + frame.height + 1;
};

test.describe('a channel with unread messages', () => {
  test.setTimeout(120_000);

  test('opens on the unread marker, with the marker in sight and the first unread message under it', async ({
    page,
    signIn,
    room,
    tenant,
    api,
  }) => {
    const made = await roomWithHistory(tenant, room, 130);
    const viewer = api('dogancan');
    const ids = await idsOf(viewer, made.id);
    expect(ids).toHaveLength(130);
    // Read up to the 40th: ninety are unread, more than the first page the feed asks for.
    await viewer.markRead(made.id, ids[39] ?? '');
    await signIn();
    await page.goto(made.path);

    const marker = page.locator('[data-feed-marker]');
    await expect(marker).toBeVisible();
    await expect.poll(() => visibleWithin(page, marker)).toBe(true);
    const firstUnread = page.locator(`[data-message-id="${ids[40] ?? ''}"]`);
    await expect(firstUnread).toBeVisible();
    // The marker sits directly above the first message past the read position, and not above
    // some later one: the row just under the line is the 41st.
    const markerBox = await marker.boundingBox();
    const rowBox = await firstUnread.boundingBox();
    expect(rowBox?.y ?? 0).toBeGreaterThan(markerBox?.y ?? 0);
    expect((rowBox?.y ?? 0) - (markerBox?.y ?? 0)).toBeLessThan(80);
    // A channel opened at its marker is not read: the person has not got to the bottom.
    await page.waitForTimeout(900);
    expect((await viewer.channelState(made.id))?.unreadCount).toBe(90);
  });

  test('keeps the marker while the person reads past it, and reading to the bottom marks the channel read', async ({
    page,
    signIn,
    room,
    tenant,
    api,
  }) => {
    const made = await roomWithHistory(tenant, room, 90);
    const viewer = api('dogancan');
    const ids = await idsOf(viewer, made.id);
    await viewer.markRead(made.id, ids[29] ?? '');
    await signIn();
    await page.goto(made.path);
    const marker = page.locator('[data-feed-marker]');
    await expect(marker).toBeVisible();

    await scroller(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    // Past the marker now, and it is still in the document: it is the reader's place-holder.
    await expect(page.locator(`[data-message-id="${ids.at(-1) ?? ''}"]`)).toBeVisible();
    await expect(marker).toHaveCount(1);
    await expect
      .poll(async () => (await viewer.channelState(made.id))?.unreadCount, { timeout: 5_000 })
      .toBe(0);
    expect((await viewer.channelState(made.id))?.lastReadMessageId).toBe(ids.at(-1));
    // The sidebar badge and weight follow, from the server's own state.
    await expect(await navLink(page, made.name)).not.toContainText('unread');

    await page.reload();
    await expect(page.locator('[data-feed-marker]')).toHaveCount(0);
    await expect
      .poll(() => scroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(2);
  });

  test('a channel read to its end opens at the bottom, with the newest message fully in sight', async ({
    page,
    signIn,
    room,
    tenant,
    api,
  }) => {
    const made = await roomWithHistory(tenant, room, 70);
    const viewer = api('dogancan');
    const ids = await idsOf(viewer, made.id);
    await viewer.markRead(made.id, ids.at(-1) ?? '');
    await signIn();
    await page.goto(made.path);
    const last = page.locator(`[data-message-id="${ids.at(-1) ?? ''}"]`);
    await expect(last).toBeVisible();
    await expect.poll(() => visibleWithin(page, last)).toBe(true);
    await expect(page.locator('[data-feed-marker]')).toHaveCount(0);
  });
});

test.describe('a reader who has scrolled up', () => {
  test.setTimeout(120_000);

  test('is not moved by what arrives below, is told how much is waiting, and the pill takes them down', async ({
    page,
    signIn,
    room,
    tenant,
    api,
  }) => {
    const made = await roomWithHistory(tenant, room, 60);
    const viewer = api('dogancan');
    const ids = await idsOf(viewer, made.id);
    await viewer.markRead(made.id, ids.at(-1) ?? '');
    await signIn();
    await page.goto(made.path);
    await expect(page.locator(`[data-message-id="${ids.at(-1) ?? ''}"]`)).toBeVisible();

    const anchor = page.locator(`[data-message-id="${ids[40] ?? ''}"]`);
    await scroller(page).evaluate((el) => {
      el.scrollTop = el.scrollTop - 600;
    });
    await expect(anchor).toBeVisible();
    const before = (await anchor.boundingBox())?.y ?? 0;

    const speaker = api('carol');
    await speaker.say(made.id, 'arrived while you were reading up the page');
    await speaker.say(made.id, 'and another');
    await speaker.say(made.id, 'and a third');
    const pill = page.getByRole('button', { name: /new messages?$/ });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveAccessibleName('3 new messages');
    // Nothing moved under the reader.
    expect(Math.abs(((await anchor.boundingBox())?.y ?? 0) - before)).toBeLessThan(1.5);
    // And nothing was marked read: they have not got there.
    expect((await viewer.channelState(made.id))?.unreadCount).toBe(3);

    await page.getByRole('button', { name: '3 new messages' }).click();
    await expect(page.getByText('and a third')).toBeVisible();
    await expect(page.getByRole('button', { name: /new messages?$/ })).toHaveCount(0);
    await expect
      .poll(() => scroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(2);
  });

  test('a reader within eighty pixels of the bottom is carried down by what arrives, and nobody else is', async ({
    page,
    signIn,
    room,
    tenant,
    api,
  }) => {
    const made = await roomWithHistory(tenant, room, 40);
    const viewer = api('dogancan');
    const ids = await idsOf(viewer, made.id);
    await viewer.markRead(made.id, ids.at(-1) ?? '');
    await signIn();
    await page.goto(made.path);
    await expect(page.locator(`[data-message-id="${ids.at(-1) ?? ''}"]`)).toBeVisible();

    await scroller(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight - el.clientHeight - 60;
    });
    await api('carol').say(made.id, 'arrives within the sticky zone');
    await expect(page.getByText('arrives within the sticky zone')).toBeVisible();
    await expect
      .poll(() => scroller(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
      .toBeLessThan(2);
    await expect(page.getByRole('button', { name: /new messages?$/ })).toHaveCount(0);
  });

  test('older history loads above without moving the row the reader was looking at', async ({
    page,
    signIn,
    room,
    tenant,
    api,
  }) => {
    // One person wrote all of it, so every row but the first of the loaded page is a continuation
    // with no name line — and the first loses its own when the page above arrives and it becomes one.
    const made = await roomWithHistory(tenant, room, 130, ['carol']);
    const viewer = api('dogancan');
    const ids = await idsOf(viewer, made.id);
    await viewer.markRead(made.id, ids.at(-1) ?? '');
    await signIn();
    await page.goto(made.path);
    await expect(page.locator(`[data-message-id="${ids.at(-1) ?? ''}"]`)).toBeVisible();
    const rows = page.locator('[data-message-row]');
    const loaded = await rows.count();
    expect(loaded).toBeLessThanOrEqual(60);

    // Settled first: the feed is not still fetching what it was opened with.
    await expect(page.getByRole('feed')).toHaveAttribute('aria-busy', 'false');
    // Scroll to the very top and note the first row and where it is, in the same breath: the older
    // page is asked for and prepended, and nothing may have happened between the two.
    const anchor = await scroller(page).evaluate((el) => {
      el.scrollTop = 0;
      const first = el.querySelector('[data-message-row]');
      return {
        id: first?.getAttribute('data-message-id') ?? '',
        top: first?.getBoundingClientRect().top ?? 0,
      };
    });
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeGreaterThan(loaded);
    await page.waitForTimeout(300);
    const after = (await page.locator(`[data-message-id="${anchor.id}"]`).boundingBox())?.y ?? 0;
    const before = anchor.top;
    // The row that was at the top of the viewport is still where it was — even when it is no longer
    // the first of its sender's run and has lost its name line (the history is written by two people
    // at once, so where a run begins varies from room to room: that is what made this flaky).
    expect(Math.abs(after - before)).toBeLessThan(3);
    // The document itself never scrolled to do it.
    expect(await page.evaluate(() => document.documentElement.scrollTop)).toBe(0);
  });
});
