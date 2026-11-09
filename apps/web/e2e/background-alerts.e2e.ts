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
  readonly renotify: boolean;
  readonly silent?: boolean;
}

declare global {
  interface Window {
    /** What the page asked the browser to show, in order. */
    shownNotices?: (Recorded & {
      closed: boolean;
      readonly open: () => void;
      readonly refuse: () => void;
    })[];
    /** The person is in another window. */
    elsewhere?: boolean;
    audioCueStarts?: number;
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
      onerror: (() => void) | null = null;
      readonly record: NonNullable<Window['shownNotices']>[number];
      constructor(title: string, options: NotificationOptions = {}) {
        this.record = {
          title,
          body: options.body ?? '',
          tag: options.tag ?? '',
          renotify: Reflect.get(options, 'renotify') === true,
          silent: options.silent ?? false,
          closed: false,
          open: (): void => this.onclick?.(),
          refuse: (): void => this.onerror?.(),
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

/**
 * Resolves when the page's socket has been answered a subscription (`ACK` with `channels`): from then on it is
 * told live, and it has read again what a frame before it would have told. Armed before the page is opened,
 * since the socket is made while it loads.
 */
const socketSubscribed = (page: Page): Promise<void> =>
  new Promise((resolve) => {
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload === 'string' && /"event":"ACK".*"channels"/.test(payload)) resolve();
      });
    });
  });

test.describe('a tab in the background', () => {
  test.skip(
    () => test.info().project.name !== 'chromium-dark',
    'a notice and an icon look the same in every theme and width',
  );

  test('two tabs share one alert, the focused tab shows its card, and preferences follow both tabs', async ({
    newcomer,
    expectNoAxe,
  }) => {
    const viewer = await newcomer('shared-alert-viewer');
    const writer = await newcomer('shared-alert-writer');
    const workspace = await workspaceFor(viewer, writer);
    const first = await viewer.page();
    const second = await first.context().newPage();
    for (const page of [first, second]) {
      await recordNotices(page, viewer.userId);
      // Headless windows do not reproduce a person's focus; keep only that external boundary controlled.
      await page.addInitScript(() => {
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
        window.elsewhere = true;
      });
      await page.addInitScript(() => {
        window.audioCueStarts = 0;
        const start: unknown = Reflect.get(OscillatorNode.prototype, 'start');
        if (typeof start !== 'function') throw new Error('Native oscillator start unavailable');
        OscillatorNode.prototype.start = function (when?: number): void {
          window.audioCueStarts = (window.audioCueStarts ?? 0) + 1;
          Reflect.apply(start, this, [when]);
        };
      });
      const subscribed = socketSubscribed(page);
      await page.goto(`/w/${workspace.slug}/inbox`);
      await shellReady(page);
      await subscribed;
    }
    const dm = await writer.api.post<Channel>(`/api/workspaces/${workspace.id}/dms`, {
      userId: viewer.userId,
    });
    const total = async (): Promise<number> =>
      (await first.evaluate(() => window.shownNotices?.length ?? 0)) +
      (await second.evaluate(() => window.shownNotices?.length ?? 0));
    await writer.api.say(dm.id, 'first plain message');
    await expect.poll(total).toBe(1);
    await expect(first).toHaveTitle(/^\(1\)/);
    await expect(second).toHaveTitle(/^\(1\)/);
    await writer.api.say(dm.id, 'second plain message');
    await expect.poll(total).toBe(2);
    await expect(first).toHaveTitle(/^\(2\)/);
    await expect(second).toHaveTitle(/^\(2\)/);
    expect(await second.evaluate(() => window.audioCueStarts)).toBe(0);
    await second.evaluate(() => {
      window.elsewhere = false;
      window.dispatchEvent(new Event('focus'));
    });
    await expect
      .poll(() =>
        second.evaluate(
          async () =>
            (await navigator.locks.query()).held?.some((lock) => lock.name?.endsWith(':focus')) ??
            false,
        ),
      )
      .toBe(true);
    await second.keyboard.press('Shift');
    await writer.api.say(dm.id, 'third plain message');
    const open = second.getByRole('button', { name: 'Open conversation' });
    await expect(open).toBeVisible();
    await expect.poll(() => second.evaluate(() => window.audioCueStarts)).toBe(1);
    await expect(first.getByRole('button', { name: 'Open conversation' })).toHaveCount(0);
    expect(await total()).toBe(2);
    await open.focus();
    await second.keyboard.press('Enter');
    await expect(second).toHaveURL(new RegExp(`/c/${dm.id}`));
    await expect(first).not.toHaveTitle(/^\(\d+\)/);
    for (const page of [first, second])
      await page.goto(`/w/${workspace.slug}/settings/notifications`);
    await second.getByRole('checkbox', { name: 'Notification sound' }).uncheck();
    await expect(first.getByRole('checkbox', { name: 'Notification sound' })).not.toBeChecked();
    await second.getByRole('checkbox', { name: 'In-app message cards' }).uncheck();
    await expect(first.getByRole('checkbox', { name: 'In-app message cards' })).not.toBeChecked();
    for (const page of [first, second])
      await page.evaluate(() => {
        window.elsewhere = true;
        window.dispatchEvent(new Event('blur'));
      });
    await writer.api.say(dm.id, 'fourth plain message');
    // Navigations reset the recording boundary; exactly one of the two tabs requests this alert.
    await expect.poll(total).toBe(1);
    const records = [
      ...(await first.evaluate(() => window.shownNotices ?? [])),
      ...(await second.evaluate(() => window.shownNotices ?? [])),
    ];
    expect(records[0]?.silent).toBe(true);
    expect(await second.evaluate(() => window.audioCueStarts)).toBe(0);
    const delivery = second.getByRole('region', { name: 'How you hear about messages' });
    await delivery.getByRole('checkbox', { name: 'In-app message cards' }).scrollIntoViewIfNeeded();
    await expectNoAxe(delivery);
    await second.screenshot({ path: test.info().outputPath('notification-settings-dark.png') });
    await second.setViewportSize({ width: 320, height: 720 });
    await second.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
    await delivery.getByRole('checkbox', { name: 'In-app message cards' }).scrollIntoViewIfNeeded();
    await expect(delivery).toBeVisible();
    await expectNoAxe(delivery);
    expect(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await second.screenshot({
      path: test.info().outputPath('notification-settings-light-narrow.png'),
    });
    await delivery
      .getByRole('status')
      .filter({ hasText: 'Audio is ready in this tab.' })
      .scrollIntoViewIfNeeded();
    await second.screenshot({
      path: test.info().outputPath('notification-settings-light-narrow-volume.png'),
    });
  });

  test('device tests request fresh alerts and report only the current browser refusal', async ({
    newcomer,
  }) => {
    const viewer = await newcomer('device-test-viewer');
    const workspace = await workspaceFor(viewer);
    const page = await viewer.page();
    await recordNotices(page, viewer.userId);
    await page.goto(`/w/${workspace.slug}/settings/notifications`);
    await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
    const card = page.getByRole('region', { name: 'Notifications on this device' });
    const button = card.getByRole('button', { name: 'Test notification' });
    await expect(button).toBeEnabled();
    await button.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.shownNotices?.length)).toBe(1);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.shownNotices?.length)).toBe(2);
    const records = await page.evaluate(() =>
      window.shownNotices?.map(({ tag, closed }) => ({ tag, closed })),
    );
    expect(new Set(records?.map(({ tag }) => tag)).size).toBe(2);
    expect(records?.map(({ closed }) => closed)).toEqual([true, false]);
    await page.evaluate(() => window.shownNotices?.[0]?.refuse());
    await expect(
      page.getByText(/^Your browser could not show the test notification\./),
    ).toBeHidden();
    await expect(page.getByText(/^Test notification requested\./)).toHaveCount(1);
    await page.evaluate(() => window.shownNotices?.[1]?.refuse());
    await expect(
      page.getByText(/^Your browser could not show the test notification\./),
    ).toBeVisible();
    await expect(page.getByText(/^Test notification requested\./)).toBeHidden();
  });

  test('every ordinary DM requests an alert while away, including the first message from a person', async ({
    newcomer,
  }) => {
    const viewer = await newcomer('dm-alert-viewer');
    const writer = await newcomer('dm-alert-writer');
    const workspace = await workspaceFor(viewer, writer);
    const page = await viewer.page();
    await recordNotices(page, viewer.userId);
    const subscribed = socketSubscribed(page);
    await page.goto(`/w/${workspace.slug}/inbox`);
    await shellReady(page);
    await subscribed;
    await page.evaluate(() => {
      window.elsewhere = true;
      window.dispatchEvent(new Event('blur'));
    });
    const dm = await writer.api.post<Channel>(`/api/workspaces/${workspace.id}/dms`, {
      userId: viewer.userId,
    });
    const notices = (): Promise<Recorded[]> =>
      page.evaluate(
        (tag) =>
          (window.shownNotices ?? [])
            .filter((notice) => notice.tag === tag)
            .map(({ title, body, tag, renotify }) => ({ title, body, tag, renotify })),
        `purlay:c:${dm.id}`,
      );
    for (const [index, content] of ['First private message', 'Second private message'].entries()) {
      await writer.api.say(dm.id, content);
      await expect.poll(notices).toHaveLength(index + 1);
      const latest = (await notices()).at(-1);
      expect(latest?.renotify).toBe(true);
      expect(latest?.body).not.toContain(content);
    }
  });

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
      window.dispatchEvent(new Event('blur'));
    });
    await api('carol').say(there.id, `@dogancan please look at ${there.name}`);

    const told = (): Promise<Recorded[]> =>
      page.evaluate(() =>
        (window.shownNotices ?? []).map(({ title, body, tag, renotify }) => ({
          title,
          body,
          tag,
          renotify,
        })),
      );
    // Other specs mention this person too, in rooms of their own: this room's notice is the one.
    await expect
      .poll(async () => (await told()).find((n) => n.title === `#${there.name}`))
      .toEqual({
        title: `#${there.name}`,
        body: 'Carol Reyes mentioned you',
        tag: `purlay:c:${there.id}`,
        renotify: true,
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
        window.dispatchEvent(new Event('blur'));
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
    // The socket opens late on every load, as it does on a busy runner: what the page read before it opened is what it
    // knows until the first answer, and a mention written in that gap is a first look, not news. Held on purpose, so
    // the test waits for the socket (`socketSubscribed`) and does not depend on it being quick.
    await page.routeWebSocket('**/ws', (ws) => {
      const queued: (string | Buffer)[] = [];
      let server: ReturnType<typeof ws.connectToServer> | null = null;
      ws.onMessage((m) => {
        if (server === null) queued.push(m);
        else server.send(m);
      });
      setTimeout(() => {
        server = ws.connectToServer();
        for (const m of queued) server.send(m);
      }, 2500);
    });
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
    // What the page itself shows, not the server's count: a notice is told only of a badge that *rises* in the
    // page's own list, and a mention written while that list still holds an older count is a first look, not news.
    // The row with no mention count on it (the channel's name has no digit) says the page has caught up with the read
    // this test waited for above.
    const pageHasCaughtUp = async (): Promise<void> => {
      const row = await navLink(page, 'notifications');
      await expect(row).toBeVisible();
      await expect(row).not.toHaveText(/\d/);
    };
    const notices = async (): Promise<{ closed: boolean }[]> =>
      await page.evaluate(() => (window.shownNotices ?? []).map(({ closed }) => ({ closed })));

    for (const level of ['all', 'mentions', 'none'] as const) {
      await viewer.api.put(`/api/channels/${channel.id}/notification-level`, { level });
      const subscribed = socketSubscribed(page);
      await page.goto(path);
      await shellReady(page);
      await subscribed;
      await expect.poll(async () => (await state())?.unreadMentionCount).toBe(0);
      await pageHasCaughtUp();
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
    const threadSubscribed = socketSubscribed(page);
    await page.goto(`${path}?thread=${root.id}`);
    const thread = page.locator(`[data-thread-root="${root.id}"]`);
    await expect(thread.getByText('The first answer', { exact: true })).toBeVisible();
    await threadSubscribed;
    await expect.poll(async () => (await state())?.unreadMentionCount).toBe(0);
    await pageHasCaughtUp();
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
