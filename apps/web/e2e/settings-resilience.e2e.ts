/** Settings under narrow screens, delayed responses and failed reads. */
import { expect, test } from './fixtures';
import { openNavigation, openSettings } from './support';

const SECTIONS = [
  ['profile', 'Profile'],
  ['preferences', 'Preferences'],
  ['notifications', 'Notifications'],
  ['shortcuts', 'Keyboard shortcuts'],
  ['account', 'Sessions & account'],
  ['about', 'About'],
  ['general', 'General'],
  ['members', 'Members'],
  ['integrations', 'Integrations'],
  ['audit', 'Audit log'],
  ['data', 'Data & retention'],
] as const;

for (const [section, title] of SECTIONS) {
  test(`${title} fits 320 CSS px and its editable controls do not trigger iOS focus zoom`, async ({
    page,
    signIn,
    tenant,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await signIn();
    const main = await openSettings(page, tenant.slug, section, title);
    await expect
      .poll(
        async () => await main.evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const small = await main
      .locator(
        'input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),select,textarea',
      )
      .evaluateAll((elements) =>
        elements
          .filter((element) => {
            const style = getComputedStyle(element);
            return (
              element.getBoundingClientRect().width > 0 &&
              style.visibility !== 'hidden' &&
              Number.parseFloat(style.fontSize) < 16
            );
          })
          .map((element) => ({
            type: element.getAttribute('type') ?? element.tagName,
            label: element.getAttribute('aria-label') ?? element.id,
            size: getComputedStyle(element).fontSize,
          })),
      );
    expect(small).toEqual([]);
    if (info.project.name === 'chromium-light') {
      const path = info.outputPath(`${section}-320.png`);
      await page.screenshot({ path, fullPage: true });
      await info.attach(`${section}-320`, { path, contentType: 'image/png' });
    }
  });
}

test('quiet hours retries a failed read, rejects an empty time, and holds edits while saving', async ({
  newcomer,
}) => {
  const person = await newcomer('quiet-settings');
  const workspace = await person.api.post<{ id: string; slug: string }>('/api/workspaces', {
    name: 'Quiet settings',
    slug: `quiet-${crypto.randomUUID().slice(0, 8)}`,
  });
  await person.api.patch('/api/me/profile', { timeZone: 'Europe/Istanbul' });
  const page = await person.page();
  await page.setViewportSize({ width: 320, height: 900 });
  let failed = true;
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route('**/api/me/quiet-hours', async (route) => {
    if (route.request().method() === 'GET' && failed) {
      await route.fulfill({
        status: 400,
        json: { error: { code: 'VALIDATION_FAILED', message: 'test read failure' } },
      });
    } else if (route.request().method() === 'PUT') {
      await pending;
      await route.continue();
    } else await route.continue();
  });
  await page.goto(`/w/${workspace.slug}/settings/notifications`);
  const card = page.getByRole('region', { name: 'Quiet hours' });
  await expect(card.getByText('Quiet hours could not be loaded.')).toBeVisible();
  failed = false;
  await card.getByRole('button', { name: 'Retry' }).click();
  await card.getByRole('checkbox', { name: 'Quiet hours', exact: true }).check();
  const from = card.getByLabel('From', { exact: true });
  await from.fill('');
  await expect(card.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(card.getByText('Enter a start and end time.')).toBeVisible();
  const bounds = await card.boundingBox();
  if (bounds === null) throw new Error('quiet-hours card has no bounds');
  for (const time of [from, card.getByLabel('to', { exact: true })]) {
    const box = await time.boundingBox();
    if (box === null) throw new Error('time field has no bounds');
    expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
  }
  await from.fill('20:30');
  await card.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(from).toBeDisabled();
  await expect(card.getByRole('checkbox', { name: 'Monday' })).toBeDisabled();
  finish?.();
  await expect(card.getByText('Saved.', { exact: true })).toBeVisible();
  expect(await person.api.get('/api/me/quiet-hours')).toMatchObject({
    quietHours: { from: 1230, to: 540, days: [1, 2, 3, 4, 5] },
  });
  const navigateSettings = async (name: string): Promise<void> => {
    await openNavigation(page);
    await page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('link', { name, exact: true })
      .click();
  };
  await navigateSettings('Profile');
  const zone = page.getByRole('combobox', { name: 'Time zone' });
  await zone.fill('Asia/Tokyo');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await navigateSettings('Notifications');
  await expect(card.getByText('Times are in Asia/Tokyo.', { exact: true })).toBeVisible();
});

test('a long sign-in address stays inside its settings card at wide and narrow widths', async ({
  page,
  signIn,
  tenant,
}) => {
  const email = `${'x'.repeat(64)}@${'a'.repeat(63)}.${'b'.repeat(55)}.test`;
  await page.route('**/api/me/sign-in', async (route) => {
    await route.fulfill({
      json: {
        email,
        emailLinks: true,
        hasPassword: false,
        github: null,
        oidc: false,
        google: false,
        twoFactor: false,
        twoFactorRequired: false,
      },
    });
  });
  await signIn();
  const main = await openSettings(page, tenant.slug, 'account', 'Sessions & account');
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const address = main.getByText(email, { exact: true });
    await expect(address).toBeVisible();
    await expect
      .poll(
        async () =>
          await address.evaluate((element) => {
            const container = element.closest('section');
            return (
              container !== null &&
              element.getBoundingClientRect().right <= container.getBoundingClientRect().right
            );
          }),
      )
      .toBe(true);
  }
});
