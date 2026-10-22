/**
 * Signing out everywhere (D-124, D-146), against the real API: from the account menu's Settings to
 * the Sessions & account page, where it asks first and then ends a session in another browser.
 *
 * As an outsider (`fixtures.ts`): signing out everywhere ends every session the person holds, and
 * done as one of the seeded four it would sign every other test of the run out.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test, workspaceFor } from './fixtures';
import { openNav, shellReady } from './support';

/** Sessions & account, the way a person goes: the account menu's Settings, then the page by name. */
const sessionsPage = async (page: Page): Promise<Locator> => {
  await openNav(page);
  await page.getByRole('button', { name: /^Account: / }).click();
  await page.getByRole('menuitem', { name: /^Settings/ }).click();
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible();
  await (await openNav(page)).getByRole('link', { name: 'Sessions & account' }).click();
  await expect(main.getByRole('heading', { level: 1, name: 'Sessions & account' })).toBeVisible();
  return main;
};

test.describe('signing out everywhere', () => {
  test('signing out everywhere ends the session in the other browser too', async ({ newcomer }) => {
    // A person of this test alone: signing out everywhere ends every session they hold, so a shared
    // person would end the sessions of whichever other test (or repeat, or retry) leaned on them.
    const person = await newcomer('signs-out');
    const workspace = await workspaceFor(person);
    const here = await person.page();
    const there = await person.pageWithAnotherSession();
    for (const page of [here, there]) {
      await page.goto(`/w/${workspace.slug}`);
      await shellReady(page);
    }

    const main = await sessionsPage(here);
    await main.getByRole('button', { name: 'Sign out everywhere…' }).click();
    const dialog = here.getByRole('dialog', { name: 'Sign out everywhere?' });
    await dialog.getByRole('button', { name: 'Sign out everywhere' }).click();
    // The one who chose to sign out is not told their session ended: they ended it.
    await expect(here).toHaveURL(/\/sign-in$/);

    // The other browser was told over its socket, and its session is gone on the server too —
    // and it says why it is on the sign-in screen (#693).
    await expect(there).toHaveURL(/\/sign-in\?reason=ended$/);
    await expect(there.getByRole('heading', { level: 1, name: 'Sign in to Purlay' })).toBeVisible();
    await expect(there.getByText('Your session ended')).toBeVisible();
    await there.goto(`/w/${workspace.slug}`);
    await expect(there).toHaveURL(/\/sign-in/);
  });
});

/**
 * How you sign in (D-176, D-179 §5), against the real API: the card names the address and, where GitHub
 * is linked, the login — and offers nothing to press, since GitHub is linked by signing in with it.
 */
test.describe('how you sign in', () => {
  test('an account made by email shows its address and a link that signs in, and nothing to connect', async ({
    newcomer,
  }) => {
    const person = await newcomer('reads-how');
    const workspace = await workspaceFor(person);
    const page = await person.page();
    await page.goto(`/w/${workspace.slug}/settings/account`);
    const card = page.getByRole('region', { name: 'How you sign in' });
    await expect(card.getByText(`${person.username}@elsewhere.example`)).toBeVisible();
    await expect(card.getByText('A sign-in link sent to this address signs you in.')).toBeVisible();
    await expect(card.getByRole('button')).toHaveCount(0);
    await expect(card.getByText('GitHub', { exact: true })).toHaveCount(0);
  });

  test('an account GitHub made says it signs in with GitHub, and shows the login, read only', async ({
    asOutsider,
    workspaceOf,
  }) => {
    const workspace = await workspaceOf('erin');
    const page = await asOutsider('erin', 'fresh');
    await page.goto(`/w/${workspace.slug}/settings/account`);
    const card = page.getByRole('region', { name: 'How you sign in' });
    await expect(
      card.getByText('Your GitHub account’s address. You sign in with GitHub.'),
    ).toBeVisible();
    await expect(card.getByText('You can sign in with this GitHub account.')).toBeVisible();
    await expect(card.getByRole('button')).toHaveCount(0);
  });
});
