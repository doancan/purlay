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
import { expect, test } from './fixtures';
import { openNav, shellReady } from './support';

interface Recorded {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

declare global {
  interface Window {
    /** What the page asked the browser to show, in order. */
    shownNotices?: (Recorded & { readonly open: () => void })[];
    /** The person is in another window. */
    elsewhere?: boolean;
  }
}

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
    await page.addInitScript(() => {
      window.shownNotices = [];
      let permission: NotificationPermission = 'default';
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
        constructor(title: string, options: NotificationOptions = {}) {
          window.shownNotices?.push({
            title,
            body: options.body ?? '',
            tag: options.tag ?? '',
            open: () => this.onclick?.(),
          });
        }
        close(): void {
          this.onclose?.();
        }
      }
      Object.defineProperty(window, 'Notification', { value: Recording, configurable: true });
      Document.prototype.hasFocus = (): boolean => window.elsewhere !== true;
    });

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
});
