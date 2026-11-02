/**
 * An open tab in the background (D-148), end to end: the person turns notifications on in
 * settings, looks at another window, and a mention written through the API reaches them as a
 * notice from the browser — who and where — with a dot on the tab's icon; clicking it opens the
 * conversation.
 *
 * Two things of the browser's are replaced, and nothing of the page's. The headless browser refuses
 * notifications whatever it is granted (`push-worker.e2e.ts` says the same), so `Notification`
 * records what it is asked to show; and a page under test always has the focus, so `hasFocus`
 * answers what the test says — the person is in another window.
 *
 * One project: what is asserted is a notice and an icon, which neither the theme nor the width
 * touches.
 */
import type { Page } from '@playwright/test';
import type { Channel, ChannelState } from '@purlay/types';
import { expect, test, workspaceFor } from './fixtures';
import { navLink, openNav, shellReady } from './support';

interface Recorded {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

declare global {
  interface Window {
    /** What the page asked the browser to show, in order. */
    shownNotices?: (Recorded & { closed: boolean; readonly open: () => void })[];
    /** The person is in another window. */
    elsewhere?: boolean;
  }
}

const recordNotices = async (page: Page, owner: string | null = null): Promise<void> => {
  await page.addInitScript((owner: string | null) => {
    window.shownNotices = [];
    if (owner !== null) {
      localStorage.setItem('purlay.person', owner);
      localStorage.setItem('purlay.push.owner', owner);
    }
    let permission: NotificationPermission = owner === null ? 'default' : 'granted';
    class Recording {
      static get permission(): NotificationPermission {
        return permission;
      }
      static requestPermission(): Promise<NotificationPermission> {
        permission = 'granted';
        return Promise.resolve(permission);
      }
      onclick: (() => void) | null = null;
      onclose: (() => void) | null = null;
      readonly record: NonNullable<Window['shownNotices']>[number];
      constructor(title: string, options: NotificationOptions = {}) {
        this.record = {
          title,
          body: options.body ?? '',
          tag: options.tag ?? '',
          closed: false,
          open: (): void => this.onclick?.(),
        };
        window.shownNotices?.push(this.record);
      }
      close(): void {
        this.record.closed = true;
        this.onclose?.();
      }
    }
    Object.defineProperty(window, 'Notification', { value: Recording, configurable: true });
    Document.prototype.hasFocus = (): boolean => window.elsewhere !== true;
  }, owner);
};

test.describe('a tab in the background', () => {
  test.skip(
    () => test.info().project.name !== 'chromium-dark',
    'a notice and an icon look the same in every theme and width',
  );

  test('is told of a mention, with a dot on its icon, and the notice opens the conversation', async ({
    page,
    signIn,
    room,
    api,
  }) => {
    await recordNotices(page);
    const here = await room({ members: ['dogancan', 'carol'] });
    const there = await room({ members: ['dogancan', 'carol'] });
    await signIn();
    await page.goto(here.path);
    await shellReady(page);

    // Never asked on load: the switch asks.
    expect(await page.evaluate(() => Notification.permission)).toBe('default');
    // The switch is on the Notifications settings page (D-146), reached without a reload: one would
    // run the init script again and forget what was granted.
    await openNav(page);
    await page.getByRole('button', { name: /^Account: / }).click();
    await page.getByRole('menuitem', { name: /^Settings/ }).click();
    await page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('link', { name: 'Notifications' })
      .click();
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    await main.getByRole('button', { name: 'Turn on' }).click();
    await expect.poll(() => page.evaluate(() => Notification.permission)).toBe('granted');
    await page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('link', { name: /^Back to / })
      .click();
    await shellReady(page);
    // Somewhere other than the conversation the notice is about, so opening it is a move.
    await expect(page).toHaveURL(/\/c\//);
    expect(page.url()).not.toContain(there.id);

    await page.evaluate(() => {
      window.elsewhere = true;
    });
    await api('carol').say(there.id, `@dogancan please look at ${there.name}`);

    const told = (): Promise<Recorded[]> =>
      page.evaluate(() =>
        (window.shownNotices ?? []).map(({ title, body, tag }) => ({ title, body, tag })),
      );
    // Other specs mention this person too, in rooms of their own: this room's notice is the one.
    await expect
      .poll(async () => (await told()).find((n) => n.title === `#${there.name}`))
      .toEqual({
        title: `#${there.name}`,
        body: 'Carol Reyes mentioned you',
        tag: `purlay:c:${there.id}`,
      });
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.href),
      )
      .toMatch(/\/favicon-waiting\.svg$/);
    const icon = await page.request.get('/favicon-waiting.svg');
    expect(icon.status()).toBe(200);
    expect(icon.headers()['content-type']).toContain('image/svg+xml');

    await page.evaluate((title) => {
      window.elsewhere = false;
      window.shownNotices?.find((n) => n.title === title)?.open();
    }, `#${there.name}`);
    await expect(page).toHaveURL(new RegExp(`/c/${there.id}$`));
  });

  test('a read during a delayed lazy load leaves the other conversation’s notice intact', async ({
    newcomer,
  }) => {
    const viewer = await newcomer('lazy-viewer');
    const writer = await newcomer('lazy-writer');
    const workspace = await workspaceFor(viewer, writer);
    const channels: Channel[] = [];
    for (const name of ['first', 'second']) {
      const channel = await viewer.api.post<Channel>(`/api/workspaces/${workspace.id}/channels`, {
        name,
        type: 'public',
      });
      await writer.api.join(channel.id);
      channels.push(channel);
    }
    const [first, second] = channels;
    if (first === undefined || second === undefined || first.name === null || second.name === null)
      throw new Error('two named channels required');
    const page = await viewer.page();
    await recordNotices(page, viewer.userId);
    let release = (): void => undefined;
    let requested = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/assets/tell-*.js', async (route) => {
      requested = true;
      await gate;
      await route.continue();
    });
    try {
      await page.goto(`/w/${workspace.slug}/inbox`);
      await shellReady(page);
      await page.evaluate(() => {
        window.elsewhere = true;
      });
      await page.context().setOffline(true);
      const message = await writer.api.say(first.id, `@${viewer.username} first`);
      await writer.api.say(second.id, `@${viewer.username} second`);
      await page.context().setOffline(false);
      await expect.poll(() => requested).toBe(true);
      await expect(await navLink(page, first.name)).toContainText('unread');
      await expect(await navLink(page, second.name)).toContainText('unread');
      await viewer.api.markRead(first.id, message.id);
      await expect(await navLink(page, first.name)).not.toContainText('unread');
      release();
      await expect
        .poll(() => page.evaluate(() => window.shownNotices?.map((n) => n.title)))
        .toEqual([`#${second.name}`]);
    } finally {
      release();
      await page.context().setOffline(false);
    }
  });

  test('an unfocused open channel and thread keep their notifications until the person returns', async ({
    newcomer,
  }) => {
    const viewer = await newcomer('notice-viewer');
    const writer = await newcomer('notice-writer');
    const workspace = await workspaceFor(viewer, writer);
    const channel = await viewer.api.post<Channel>(`/api/workspaces/${workspace.id}/channels`, {
      name: 'notifications',
      type: 'public',
    });
    await writer.api.join(channel.id);
    const page = await viewer.page();
    await recordNotices(page, viewer.userId);
    const path = `/w/${workspace.slug}/c/${channel.id}`;
    const state = async (): Promise<ChannelState | null> =>
      (await viewer.api.get<Channel[]>(`/api/workspaces/${workspace.id}/channels`)).find(
        (c) => c.id === channel.id,
      )?.state ?? null;
    const away = async (elsewhere: boolean): Promise<void> => {
      await page.evaluate((next) => {
        window.elsewhere = next;
        window.dispatchEvent(new Event(next ? 'blur' : 'focus'));
      }, elsewhere);
    };
    const notices = async (): Promise<{ closed: boolean }[]> =>
      await page.evaluate(() => (window.shownNotices ?? []).map(({ closed }) => ({ closed })));

    for (const level of ['all', 'mentions', 'none'] as const) {
      await viewer.api.put(`/api/channels/${channel.id}/notification-level`, { level });
      await page.goto(path);
      await shellReady(page);
      await expect.poll(async () => (await state())?.unreadMentionCount).toBe(0);
      await away(true);
      const words =
        level === 'all' ? 'An ordinary channel message' : `@${viewer.username} ${level}`;
      await writer.api.say(channel.id, words);
      await expect(page.getByText(words, { exact: true })).toBeVisible();
      // A negative invariant: wait past the read debounce that used to clear this notice.
      await page.waitForTimeout(900);
      expect(await state()).toMatchObject({
        unreadCount: 1,
        unreadMentionCount: level === 'none' ? 0 : 1,
      });
      expect(await notices()).toEqual(level === 'none' ? [] : [{ closed: false }]);
      await away(false);
      await expect.poll(async () => (await state())?.unreadCount).toBe(0);
      await expect.poll(notices).toEqual(level === 'none' ? [] : [{ closed: true }]);
    }

    await viewer.api.put(`/api/channels/${channel.id}/notification-level`, { level: 'mentions' });
    const root = await viewer.api.say(channel.id, 'A question for the thread');
    await writer.api.say(channel.id, 'The first answer', { parentId: root.id });
    await page.goto(`${path}?thread=${root.id}`);
    const thread = page.locator(`[data-thread-root="${root.id}"]`);
    await expect(thread.getByText('The first answer', { exact: true })).toBeVisible();
    await expect.poll(async () => (await state())?.unreadMentionCount).toBe(0);
    await away(true);
    await writer.api.say(channel.id, 'The answer while you are elsewhere', { parentId: root.id });
    await expect(
      thread.getByText('The answer while you are elsewhere', { exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(900);
    expect((await state())?.unreadMentionCount).toBe(1);
    expect(await notices()).toEqual([{ closed: false }]);
    await away(false);
    await expect.poll(async () => (await state())?.unreadMentionCount).toBe(0);
    await expect.poll(notices).toEqual([{ closed: true }]);
  });
});
