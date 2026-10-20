/**
 * Every page of Settings (D-146) under the accessibility audit (axe, WCAG 2.0/2.1 A and AA, contrast
 * included), as its owner sees it — the role that is offered every page. Each project is a theme and
 * a width, so each page is audited in both themes, wide and narrow.
 *
 * The list is checked against the navigation itself first: a page added to Settings and not to this
 * list fails here, rather than shipping unaudited.
 */
import { expect, test } from './fixtures';
import { openSettings } from './support';

const PAGES = [
  ['profile', 'Profile'],
  ['preferences', 'Preferences'],
  ['notifications', 'Notifications'],
  ['shortcuts', 'Keyboard shortcuts'],
  ['account', 'Sessions & account'],
  ['general', 'General'],
  ['members', 'Members'],
  ['invitations', 'Invitations'],
  ['integrations', 'Integrations'],
  ['audit', 'Audit log'],
  ['data', 'Data & retention'],
] as const;

test.describe('every page of Settings', () => {
  test('is the list audited here, as the navigation offers it to an owner', async ({
    page,
    signIn,
    tenant,
  }) => {
    await signIn();
    const main = await openSettings(page, tenant.slug, 'profile', 'Profile');
    await expect(main).toBeVisible();
    // On a narrow window the navigation is behind its toggle.
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    if (await toggle.isVisible()) await toggle.click();
    const navigation = page.getByRole('navigation', { name: 'Settings' });
    await expect(navigation).toBeVisible();
    const offered = await navigation
      .getByRole('link')
      .evaluateAll((links) =>
        links
          .map((link) => new URL((link as HTMLAnchorElement).href).pathname.split('/').at(-1))
          .filter((section) => section !== undefined && section !== 'settings'),
      );
    expect(offered.filter((section) => section !== tenant.slug)).toEqual(
      PAGES.map(([section]) => section),
    );
  });

  for (const [section, title] of PAGES) {
    test(`${title} passes the audit`, async ({ page, signIn, tenant, expectNoAxe }) => {
      await signIn();
      await openSettings(page, tenant.slug, section, title);
      await expectNoAxe();
    });
  }
});
