/**
 * The product on a server that runs no module (D-250, `MODULES=none`): the core's screens stand, chat is not drawn
 * and not asked for. Run by `bun run test:modules-none` against a server of its own (`playwright.config.ts`); the
 * full suite leaves this file out, because its servers run every module.
 *
 * The unit test of the frame (`chatless-shell.test.tsx`) answers from a fake; this is a real browser, a real server
 * that 404s chat's routes, and the page's own requests.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openNav, openNavigation, shellReady } from './support';

/**
 * Every route template of every module the build carries (`routes` of the manifests, read from `bundledModules` so a module
 * added later is covered with no word added here), as the server reads one: `:name` is a segment, a trailing `**` the rest.
 */
const MODULE_ROUTES: readonly RegExp[] = (
  JSON.parse(
    execFileSync(
      'bun',
      [
        '--no-env-file',
        '-e',
        "const { bundledModules } = await import('./apps/api/src/composition'); console.log(JSON.stringify(bundledModules.flatMap((module) => module.manifest.routes ?? [])));",
      ],
      { cwd: join(import.meta.dirname, '../../..'), encoding: 'utf8' },
    ),
  ) as string[]
).map((template) => {
  const segments = template.split('/').map((segment) => {
    if (segment === '**') return '(?:.*)';
    return segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${segments.join('/').replace(/\/\(\?:\.\*\)$/, '(?:/.*)?')}$`);
});

/** What a page of this test must not do: every request to a module's route, and every error the console or the page reported. */
const watch = (page: Page): { chat: string[]; errors: string[] } => {
  const seen = { chat: [] as string[], errors: [] as string[] };
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (MODULE_ROUTES.some((route) => route.test(pathname))) {
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
    for (const name of [
      'Inbox',
      'Saved',
      'Drafts',
      'Search',
      'Open questions',
      'Followed conversations',
      'Issues',
    ]) {
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
    await page.goto(`/w/${slug}/followed`);
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
    await page.goto(`/w/${world.workspace.slug}/settings/general`);
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Archived channels' })).toHaveCount(0);
    await expectNoAxe();

    expect(seen.chat, 'requests to a route of chat').toEqual([]);
    expect(seen.errors, 'errors in the console').toEqual([]);
  });
});
