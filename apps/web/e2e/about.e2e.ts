/**
 * About, and the window of release notes (D-248), against the real API and the real build: the version this
 * server runs, the newest release the server learned from its GitHub (the demo's stand-in names one far ahead of
 * any this repository will make), and the notes that open once per version per browser — shown on the first
 * screen, closed, and not shown again by a reload.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';
import { openSettings, RELEASE_NOTES_SEEN_KEY, RUNNING_VERSION } from './support';

test.describe('About', () => {
  test('names the version the server runs and the newest release, and says one is newer', async ({
    page,
    signIn,
    tenant,
    expectNoAxe,
  }) => {
    await signIn();
    const main = await openSettings(page, tenant.slug, 'about', 'About');
    const versions = main.getByRole('region', { name: 'Version' });
    await expect(versions.getByText(RUNNING_VERSION, { exact: true })).toBeVisible();
    await expect(versions.getByText('99.0.0', { exact: true })).toBeVisible();
    await expect(versions.getByText('Published Nov 1, 2026')).toBeVisible();
    await expect(versions.getByRole('status')).toHaveText('Version 99.0.0 is available.');
    await expect(versions.getByRole('link', { name: /View release on GitHub/ })).toHaveAttribute(
      'href',
      'https://github.com/doancan/purlay/releases/tag/v99.0.0',
    );
    const source = main.getByRole('region', { name: 'Open source' });
    await expect(source.getByText('AGPL-3.0-or-later')).toBeVisible();
    await expect(
      source.getByRole('link', { name: /github\.com\/doancan\/purlay/ }),
    ).toHaveAttribute('href', 'https://github.com/doancan/purlay');
    await expectNoAxe();
  });

  test('What’s new opens the notes of the running version, which a keyboard closes', async ({
    page,
    signIn,
    tenant,
  }) => {
    await signIn();
    const main = await openSettings(page, tenant.slug, 'about', 'About');
    await main.getByRole('button', { name: 'What’s new' }).click();
    const dialog = page.getByRole('dialog', { name: `What’s new in Purlay ${RUNNING_VERSION}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 3 }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test.describe('the release notes after an update', () => {
  test('open once on the first screen, and a reload does not open them again', async ({
    page,
    signIn,
    tenant,
    expectNoAxe,
  }) => {
    // The window has nothing to show without the file this version was cut with: say so, rather than time out
    // waiting for a dialog that cannot come. (`scripts/changelog.test.ts` holds that the file exists.)
    const notes = join(import.meta.dirname, `../../../docs/changelog/v${RUNNING_VERSION}.md`);
    expect(existsSync(notes), `${notes} is missing, so there are no release notes to open`).toBe(
      true,
    );
    // This browser has not seen them. The fixture's context script (`skipReleaseNotes`) marks the version seen
    // on every page load that finds no mark, and a page script runs after a context script: so this one, which
    // removes the mark, runs second and wins — and only once per tab, because on the reload below the mark closing
    // stored must stay, and the fixture's script would otherwise find it removed and put it back.
    await page.addInitScript((key) => {
      if (window.sessionStorage.getItem('about-spec-forgot') === null) {
        window.sessionStorage.setItem('about-spec-forgot', '1');
        window.localStorage.removeItem(key);
      }
    }, RELEASE_NOTES_SEEN_KEY);
    await signIn();
    await page.goto(`/w/${tenant.slug}`);
    const dialog = page.getByRole('dialog', { name: `What’s new in Purlay ${RUNNING_VERSION}` });
    await expect(dialog).toBeVisible();
    await expectNoAxe();

    await dialog.getByRole('button', { name: 'Got it' }).click();
    await expect(dialog).toBeHidden();
    expect(
      await page.evaluate((key) => window.localStorage.getItem(key), RELEASE_NOTES_SEEN_KEY),
    ).toBe(RUNNING_VERSION);

    await page.reload();
    await expect(page.getByRole('main')).toBeVisible();
    await expect(dialog).toBeHidden();
  });
});
