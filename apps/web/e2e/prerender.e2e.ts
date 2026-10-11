/**
 * The prerendered shell (D-50, #141): the first response is real layout, and the client
 * replaces it with the real frame without anything moving.
 *
 * "Before JavaScript" is a browser with JavaScript turned off — what a slow connection
 * paints while the bundle downloads. It must already have the shapes of the application
 * (a sidebar, a header, rows), carry no script of its own, and be laid out with the same
 * width tokens the real frame uses, so that the moment the client mounts is a swap, not a
 * reflow.
 */
import { expect, test } from './fixtures';

test.describe('before JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the first response has the shapes of the application, and no words', async ({ page }) => {
    await page.goto('/');
    const root = page.locator('#root');
    // A sidebar, a header and feed rows drawn as layout.
    // Below the breakpoint the sidebar is an overlay, so the skeleton draws no column for it.
    const narrow = (page.viewportSize()?.width ?? 0) < 900;
    if (narrow) await expect(root.locator('div.w-sidebar')).toBeHidden();
    else await expect(root.locator('div.w-sidebar')).toBeVisible();
    await expect(root.locator('div.h-header').first()).toBeVisible();
    expect(await root.locator('span.bg-surface-200').count()).toBeGreaterThanOrEqual(8);
    // Hidden from assistive technology: nothing to read yet, and "block, block, block" is noise.
    await expect(root.locator('[aria-hidden="true"]').first()).toBeAttached();
    expect((await root.innerText()).trim()).toBe('');
    await expect(page).toHaveScreenshot('shell-before-javascript.png');
  });

  test('is served with no inline script, so a strict content security policy can allow it', async ({
    request,
  }) => {
    const html = await (await request.get('/')).text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).toContain('<script src="/theme-init.js"></script>');
    expect(html).toContain('<div id="root"><div aria-hidden="true"');
  });
});

test.describe('the swap', () => {
  test('puts the real frame where the skeleton was: the sidebar and the header do not move', async ({
    browser,
    context,
    signIn,
    baseURL,
    world,
    securityPolicy,
  }) => {
    await signIn('bob');
    const route = `/w/${world.workspace.slug}`;

    // The skeleton, as a browser without JavaScript paints it (with the same cookie: it is
    // the same page, and a signed-in person sees exactly this first).
    const bare = await browser.newContext({ javaScriptEnabled: false, baseURL: baseURL ?? '' });
    await securityPolicy.watch(bare);
    await bare.addCookies(await context.cookies());
    const before = await bare.newPage();
    await before.goto(route);
    const skeleton = await before.evaluate(() => {
      const sidebar = document.querySelector('#root div.w-sidebar');
      const header = document.querySelector('#root div.h-header');
      return {
        sidebarWidth: sidebar?.getBoundingClientRect().width ?? -1,
        headerHeight: header?.getBoundingClientRect().height ?? -1,
      };
    });
    await securityPolicy.settle(bare);
    await bare.close();

    const page = await context.newPage();
    await page.goto(route);
    // Below the breakpoint the sidebar is an overlay, so the frame that arrives is the toggle.
    const narrow = (page.viewportSize()?.width ?? 0) < 900;
    const real = narrow
      ? page.getByRole('button', { name: 'Open navigation' })
      : page.getByRole('complementary');
    await expect(real).toBeVisible();
    const after = await page.evaluate(() => {
      const sidebar = document.querySelector('aside');
      const header = document.querySelector('header');
      return {
        sidebarWidth: sidebar?.getBoundingClientRect().width ?? -1,
        headerHeight: header?.getBoundingClientRect().height ?? -1,
      };
    });
    if (narrow) {
      // Neither the skeleton nor the page has a sidebar in the layout: nothing to move.
      expect(skeleton.sidebarWidth).toBe(0);
      expect(after.sidebarWidth).toBe(-1);
    } else {
      expect(skeleton.sidebarWidth).toBeGreaterThan(0);
      expect(after.sidebarWidth).toBe(skeleton.sidebarWidth);
    }
    // The header only exists once a channel screen does; when it does it must match.
    if (after.headerHeight > 0) expect(after.headerHeight).toBe(skeleton.headerHeight);
  });
});
