/**
 * The product on a server that runs no module (D-250, `MODULES=none`): the core's screens stand, chat is not drawn
 * and not asked for. Run by `bun run test:modules-none` against a server of its own (`playwright.config.ts`); the
 * full suite leaves this file out, because its servers run every module.
 *
 * The unit test of the frame (`chatless-shell.test.tsx`) answers from a fake; this is a real browser, a real server
 * that 404s chat's routes, and the page's own requests.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openNav, openNavigation, shellReady } from './support';

/** The paths chat and issues serve (`/api/workspaces/:id/channels`, `/api/channels/:id/messages`, …): none is asked for here. */
const CHAT_PATH =
  /\/(channels|messages|presence|unresolved|saved|drafts|notifications|search|pins|bookmarks|threads|reminders|scheduled|issues)(\/|\?|$)/;

/** What a page of this test must not do: every request to a chat route, and every error the console or the page reported. */
const watch = (page: Page): { chat: string[]; errors: string[] } => {
  const seen = { chat: [] as string[], errors: [] as string[] };
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/') && CHAT_PATH.test(pathname)) {
      seen.chat.push(`${request.method()} ${pathname}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() === 'error') seen.errors.push(message.text());
  });
  page.on('pageerror', (error) => seen.errors.push(error.message));
  return seen;
};

test.describe('a server with no module', () => {
  test('says so, and the workspace draws and asks for nothing of chat', async ({
    page,
    signIn,
    world,
    expectNoAxe,
  }) => {
    const seen = watch(page);
    await signIn();
    const slug = world.workspace.slug;

    await page.goto(`/w/${slug}`);
    await shellReady(page);
    const me = await page.evaluate(async () => {
      const response = await fetch('/api/me');
      return (await response.json()) as unknown;
    });
    expect(me).toMatchObject({ modules: [] });

    // The front door.
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Your workspace' })).toBeVisible();
    await expect(main.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expectNoAxe();

    // The rail and the sidebar.
    const sidebar = await openNav(page);
    const rail = page.getByRole('navigation', { name: 'Places' });
    for (const name of ['Inbox', 'Saved', 'Drafts', 'Search', 'Open questions', 'Issues']) {
      await expect(rail.getByRole('link', { name })).toHaveCount(0);
      await expect(sidebar.getByRole('link', { name })).toHaveCount(0);
    }
    await expect(
      sidebar.getByRole('link', { name: /^(unread )?(api|deploys|incidents)/ }),
    ).toHaveCount(0);
    await expect(rail.getByRole('link', { name: 'Settings' })).toBeVisible();
    await expectNoAxe();

    // The address of a screen of chat.
    await page.goto(`/w/${slug}/inbox`);
    await expect(page.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();
    await expectNoAxe();
    // And of issues, which is a module of its own.
    await page.goto(`/w/${slug}/issues`);
    await expect(page.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();
    await page.goto(`/w/${slug}/inbox`);
    // Its way out leads somewhere that is drawn.
    await page.getByRole('link', { name: /Go to your/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Your workspace' })).toBeVisible();

    // The palette offers no channel and no view.
    await page.goto(`/w/${slug}`);
    await shellReady(page);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await expect(
      palette.getByRole('option', { name: /#|Inbox|Saved|Drafts|Search|channel|Issues/i }),
    ).toHaveCount(0);
    await expectNoAxe(palette);
    await page.keyboard.press('Escape');

    expect(seen.chat, 'requests to a route of chat').toEqual([]);
    expect(seen.errors, 'errors in the console').toEqual([]);
  });

  test('settings list no page of chat, and the core’s pages open', async ({
    page,
    signIn,
    world,
    expectNoAxe,
  }) => {
    const seen = watch(page);
    await signIn();
    await page.goto(`/w/${world.workspace.slug}/settings`);
    await shellReady(page);
    await openNavigation(page);
    const settings = page.getByRole('navigation', { name: 'Settings' });
    await expect(settings.getByRole('link').first()).toBeVisible();
    for (const name of ['Notifications', 'Integrations']) {
      await expect(settings.getByRole('link', { name })).toHaveCount(0);
    }
    await expectNoAxe();

    expect(seen.chat, 'requests to a route of chat').toEqual([]);
    expect(seen.errors, 'errors in the console').toEqual([]);
  });
});
