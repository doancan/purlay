/**
 * Every view's loading, empty and failed state, forced and photographed (`UX.md` §8, D-53).
 *
 * A state the server rarely produces is a state nobody looks at, so each is made to happen
 * here — a request is held, refused, or answered with nothing — and checked both ways: it says
 * what it should, in words, with a way forward, and it looks like the rest of the product in
 * both themes. The snapshots are of states whose content does not depend on the day the seed
 * ran, so a baseline stays a baseline.
 */
import type { Page, Route } from '@playwright/test';
import { expect, test } from './fixtures';

const channelPath = (slug: string, id: string): string => `/w/${slug}/c/${id}`;

const fail = async (route: Route): Promise<void> => {
  await route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ error: { code: 'INTERNAL', message: 'Something went wrong.' } }),
  });
};

/** Holds a request until `release` is called, so a loading state can be looked at. */
const held = async (page: Page, url: string): Promise<{ release: () => void }> => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(url, async (route) => {
    await gate;
    await route.continue();
  });
  return { release };
};

test.describe('the channel feed', () => {
  test('is loading as skeleton rows with no spinner, and the composer is already there', async ({
    page,
    signIn,
    world,
    expectNoAxe,
  }) => {
    await signIn('bob');
    const gate = await held(page, '**/api/channels/*/messages*');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    await expect(page.getByRole('status').filter({ hasText: 'Loading messages' })).toBeVisible();
    await expect(page.locator('textarea[data-composer]')).toBeVisible();
    await expectNoAxe();
    await expect(page.getByRole('main')).toHaveScreenshot('feed-loading.png');
    gate.release();
    await expect(page.getByRole('status').filter({ hasText: 'Loading messages' })).toBeHidden();
  });

  test('is empty as an invitation, with the composer focused', async ({
    page,
    signIn,
    world,
    expectNoAxe,
  }) => {
    // The viewer, who is a member of the empty channel: Bob is not, and would be offered Join.
    await signIn('dogancan');
    await page.goto(channelPath(world.workspace.slug, world.channels.design));
    await expect(page.getByRole('heading', { name: 'No messages yet' })).toBeVisible();
    await expect(page.locator('textarea[data-composer]')).toBeFocused();
    await expectNoAxe();
    await expect(page.getByRole('main')).toHaveScreenshot('feed-empty.png');
  });

  test('has failed in words, with Retry, the composer still usable, and recovers', async ({
    page,
    signIn,
    world,
    expectNoAxe,
  }) => {
    await signIn('bob');
    let failing = true;
    await page.route('**/api/channels/*/messages*', async (route) => {
      if (route.request().method() === 'GET' && failing) await fail(route);
      else await route.continue();
    });
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    const alert = page.getByRole('alert');
    await expect(alert).toContainText("Couldn't load messages");
    await expect(page.locator('textarea[data-composer]')).toBeEnabled();
    await expectNoAxe();
    await expect(page.getByRole('main')).toHaveScreenshot('feed-error.png');
    failing = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(alert).toBeHidden();
    await expect(page.locator('article').first()).toBeVisible();
  });
});

test.describe('the open questions', () => {
  test('are loading as rows of their own shape', async ({ page, signIn, world, expectNoAxe }) => {
    await signIn('bob');
    const gate = await held(page, '**/api/workspaces/*/unresolved*');
    await page.goto(`/w/${world.workspace.slug}/questions`);
    await expect(
      page.getByRole('status').filter({ hasText: 'Loading open questions' }),
    ).toBeVisible();
    await expectNoAxe();
    await expect(page.getByRole('main')).toHaveScreenshot('questions-loading.png');
    gate.release();
  });

  test('say every thread is resolved when there are none', async ({
    page,
    signIn,
    world,
    expectNoAxe,
  }) => {
    await signIn('bob');
    await page.route('**/api/workspaces/*/unresolved*', async (route) => {
      await route.fulfill({ json: { data: [], nextCursor: null } });
    });
    await page.goto(`/w/${world.workspace.slug}/questions`);
    await expect(page.getByRole('heading', { name: 'Every thread is resolved' })).toBeVisible();
    await expectNoAxe();
    await expect(page.getByRole('main')).toHaveScreenshot('questions-empty.png');
  });

  test('fail in words, with Retry', async ({ page, signIn, world, expectNoAxe }) => {
    await signIn('bob');
    await page.route('**/api/workspaces/*/unresolved*', fail);
    await page.goto(`/w/${world.workspace.slug}/questions`);
    await expect(page.getByRole('alert')).toContainText("Couldn't load open questions");
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expectNoAxe();
    await expect(page.getByRole('main')).toHaveScreenshot('questions-error.png');
  });
});

test.describe('a thread', () => {
  const openFirstThread = async (page: Page): Promise<void> => {
    const status = page.getByRole('button', { name: /^Open ·/ }).first();
    await status.scrollIntoViewIfNeeded();
    await status.click();
  };

  test('is loading in the panel, under its root, and the root stays', async ({
    page,
    signIn,
    world,
  }) => {
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    await expect(page.locator('article').first()).toBeVisible();
    const gate = await held(page, '**/api/messages/*/thread*');
    await openFirstThread(page);
    await expect(page.getByText('Loading replies…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close thread' })).toBeVisible();
    gate.release();
    await expect(page.getByText('Loading replies…')).toBeHidden();
  });

  test('has failed in the panel, with Retry, and the root intact', async ({
    page,
    signIn,
    world,
  }) => {
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    await expect(page.locator('article').first()).toBeVisible();
    await page.route('**/api/messages/*/thread*', fail);
    await openFirstThread(page);
    await expect(page.getByText("Couldn't load replies")).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    // The root, intact, at the top of the panel.
    await expect(page.locator('[data-thread-root] article').first()).toBeVisible();
  });
});

test.describe('the channel list', () => {
  test('says it could not load, in its own section, offers Retry, and recovers', async ({
    page,
    signIn,
    world,
  }) => {
    await signIn('bob');
    let failing = true;
    await page.route('**/api/workspaces/*/channels', async (route) => {
      if (route.request().method() === 'GET' && failing) await fail(route);
      else await route.continue();
    });
    await page.goto(`/w/${world.workspace.slug}`);
    // On a narrow window the sidebar is behind its toggle.
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    await expect(toggle.or(page.getByRole('complementary', { name: 'Workspace' }))).toBeVisible();
    if (await toggle.isVisible()) await toggle.click();
    const sidebar = page
      .getByRole('complementary', { name: 'Workspace' })
      .or(page.getByRole('dialog', { name: 'Workspace' }));
    const channels = sidebar.getByRole('navigation', { name: 'Channels' });
    await expect(channels.getByRole('alert')).toContainText("Couldn't load channels");
    // The people list is built from the same list (a direct message is a channel), so it says
    // so in its own section instead of showing a half-truth; the header and the footer stay.
    await expect(sidebar.getByRole('region', { name: 'People' }).getByRole('alert')).toBeVisible();
    await expect(sidebar.getByRole('heading', { name: 'People' })).toBeVisible();
    failing = false;
    await channels.getByRole('button', { name: 'Retry' }).click();
    // The list arrives, so the front door sends the person to a channel — which, on a narrow window,
    // closes the overlay: they went somewhere. The list is there when they look again.
    await expect(page).toHaveURL(/\/c\//);
    if (await toggle.isVisible()) await toggle.click();
    await expect(sidebar.getByRole('link', { name: /deploys/ })).toBeVisible();
  });
});

test.describe('the connection', () => {
  test('is a single quiet bar that disables nothing, and goes when the socket is back', async ({
    page,
    context,
    signIn,
    world,
  }) => {
    await page.addInitScript(() => {
      const Native = window.WebSocket;
      const sockets: WebSocket[] = [];
      (window as unknown as { __sockets: WebSocket[] }).__sockets = sockets;
      (window as unknown as { __heard: number }).__heard = 0;
      (window as unknown as { __refuse: boolean }).__refuse = false;
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          // While the test says the network is gone, every new socket goes nowhere: whether the
          // browser's offline mode stops a socket to localhost is not this test's question, and under
          // load a reconnect that slipped through hid the bar before it was looked for (#347).
          super(
            (window as unknown as { __refuse: boolean }).__refuse ? 'ws://127.0.0.1:9/' : url,
            protocols,
          );
          sockets.push(this);
          this.addEventListener('message', () => {
            (window as unknown as { __heard: number }).__heard += 1;
          });
        }
      };
    });
    await signIn('bob');
    await page.goto(channelPath(world.workspace.slug, world.channels.api));
    await expect(page.locator('article').first()).toBeVisible();
    // Wait until the app has been connected, so the bar has something to be the loss of. An open
    // socket is the browser's fact; the server's first frame is the app's, and arrives only after
    // the app has rendered as connected — closing on the first would race that render.
    await page.waitForFunction(
      () =>
        (window as unknown as { __sockets: WebSocket[] }).__sockets.some(
          (s) => s.readyState === 1,
        ) && (window as unknown as { __heard: number }).__heard > 0,
    );

    // Closed while the network is still there, so the closing handshake completes and the page is
    // told; only then offline. The other order left a socket in CLOSING — seen under the full suite's
    // load as `ws://…/ws 2`, the app still believing it was open (#347). A real network that dies is
    // found by the connection's own heartbeat, which this test is not about.
    await page.evaluate(() => {
      const state = window as unknown as {
        __refuse: boolean;
        __sockets: WebSocket[];
        __closed: WebSocket[];
      };
      state.__refuse = true;
      // These, and not the reconnects that follow them, are the ones to see closed.
      state.__closed = [...state.__sockets];
      for (const socket of state.__closed) socket.close();
    });
    await page.waitForFunction(() =>
      (window as unknown as { __closed: WebSocket[] }).__closed.every(
        (socket) => socket.readyState === WebSocket.CLOSED,
      ),
    );
    await context.setOffline(true);
    const bar = page.getByRole('status').filter({ hasText: 'Reconnecting' });
    // Under the full suite's load this has failed now and then, alone never (#347). If it fails, it
    // says what the page held: every socket's address and state, and every status on the screen.
    await expect(bar)
      .toBeVisible()
      .catch(async (error: unknown) => {
        const held = await page.evaluate(() => ({
          sockets: (window as unknown as { __sockets: WebSocket[] }).__sockets.map(
            (socket) => `${socket.url} ${String(socket.readyState)}`,
          ),
          statuses: [...document.querySelectorAll('[role="status"]')]
            .map((status) => status.textContent)
            .filter((text) => text !== ''),
          heard: (window as unknown as { __heard: number }).__heard,
        }));
        throw new Error(
          `the bar never showed; the page held ${JSON.stringify(held)}: ${String(error)}`,
        );
      });
    // Writing is never refused (UX §8): the composer and Send stay enabled.
    await expect(page.locator('textarea[data-composer]')).toBeEnabled();
    // An empty box has nothing to send, and says so with aria-disabled; with a draft in it Send is live.
    await page.locator('textarea[data-composer]').fill('still writing');
    await expect(page.getByRole('button', { name: /^Send/ })).toBeEnabled();
    // The bar alone: what is under it is the feed, which depends on the day the seed ran.
    await expect(bar).toHaveScreenshot('connection-lost.png');

    await context.setOffline(false);
    await page.evaluate(() => {
      (window as unknown as { __refuse: boolean }).__refuse = false;
    });
    await expect(bar).toBeHidden({ timeout: 30_000 });
  });
});
