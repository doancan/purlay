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
  test('signing out everywhere ends the session in the other browser too', async ({
    asOutsider,
    workspaceOf,
  }) => {
    const workspace = await workspaceOf('erin');
    // Sessions of their own: this ends every session erin holds, the seeded ones included.
    const here = await asOutsider('erin', 'fresh');
    const there = await asOutsider('erin', 'fresh');
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
 * Connecting GitHub to an account made by email (D-176), against the real API. GitHub itself cannot be
 * reached from the harness, so the way there is stopped at its door and the way back is the callback
 * GitHub would send the browser to: the card, the same-origin start, and each refusal said on this
 * page in words. The finished connect is the API's integration test (`connect-github.integration.test.ts`).
 */
test.describe('connecting GitHub', () => {
  test('an account made by email is offered it here, and every way back is said on this page', async ({
    newcomer,
  }) => {
    const person = await newcomer('connects');
    const workspace = await workspaceFor(person);
    const page = await person.page();
    await page.route('https://github.com/**', async (route) => {
      await route.abort();
    });
    await page.goto(`/w/${workspace.slug}/settings/account`);
    const card = page.getByRole('region', { name: 'How you sign in' });
    await expect(card.getByText(`${person.username}@elsewhere.example`)).toBeVisible();
    await expect(card.getByText('A sign-in link sent to this address signs you in.')).toBeVisible();

    /** Connect GitHub, pressed: a same-origin POST, then the browser on its way to GitHub. */
    const pressConnect = async (): Promise<string> => {
      const started = page.waitForResponse('**/api/me/github/connect');
      const leaving = page.waitForRequest('https://github.com/**');
      await card.getByRole('button', { name: 'Connect GitHub' }).click();
      const answer = await started;
      expect(answer.request().method()).toBe('POST');
      expect(answer.status()).toBe(200);
      const to = new URL((await leaving).url());
      expect(to.pathname).toBe('/login/oauth/authorize');
      return to.searchParams.get('state') ?? '';
    };

    // GitHub came back with a state that is not the one this browser was given.
    const state = await pressConnect();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    await page.goto(`/auth/github/callback?code=a-code&state=${'0'.repeat(32)}`);
    await expect(page).toHaveURL(
      new RegExp(`/w/${workspace.slug}/settings/account\\?github=expired$`),
    );
    await expect(card.getByRole('alert')).toHaveText(
      'That connect expired or was started in another browser — nothing was connected. Press Connect GitHub again.',
    );

    // Cancelled on GitHub's screen.
    await page.goto(`/w/${workspace.slug}/settings/account`);
    const again = await pressConnect();
    await page.goto(`/auth/github/callback?error=access_denied&state=${again}`);
    await expect(page).toHaveURL(
      new RegExp(`/w/${workspace.slug}/settings/account\\?github=cancelled$`),
    );
    // The card is read again after the way back, and its skeleton is a status too: wait it out first.
    await expect(card.getByRole('button', { name: 'Connect GitHub' })).toBeVisible();
    await expect(card.getByRole('status')).toHaveText(
      'You cancelled on GitHub — nothing was connected.',
    );
  });

  test('an account GitHub made says it signs in with GitHub, and has nothing to connect', async ({
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
    await expect(card.getByRole('button', { name: 'Connect GitHub' })).toHaveCount(0);
  });
});
