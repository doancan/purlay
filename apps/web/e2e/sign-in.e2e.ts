/**
 * Signed out: where a visitor lands, what they can do, and that going to GitHub is a real
 * navigation to the API's redirect — which this test asserts without following it to
 * github.com.
 */
import { expect, test } from './fixtures';

test.describe('the sign-in screen', () => {
  test('is what a signed-out visitor gets, from any address', async ({ page }) => {
    for (const path of ['/', '/w/acme-eng', '/w/acme-eng/questions']) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Sign in to Purlay' }),
      ).toBeVisible();
    }
  });

  test('has nothing the accessibility audit objects to', async ({ page, expectNoAxe }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoAxe();
  });

  test('looks the same as it did', async ({ page }) => {
    await page.goto('/sign-in');
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
    await expect(page).toHaveScreenshot('sign-in.png');
  });

  test('offers no email form where the server sends no mail, as the demo does not', async ({
    page,
  }) => {
    const methods = page.waitForResponse('**/api/auth/methods');
    await page.goto('/sign-in');
    expect(await (await methods).json()).toEqual({ email: false });
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
  });

  /**
   * A sign-in link against the real API (D-138 §4): the token leaves the address as the page reads
   * it, and one the server has never made is the same sentence as a used one, with the way back.
   */
  test('a sign-in link that does not open says so, with the token gone from the address', async ({
    page,
    expectNoAxe,
  }) => {
    const preview = page.waitForResponse('**/auth/email/preview');
    await page.goto(`/sign-in/email#${'a'.repeat(64)}`);
    expect((await preview).status()).toBe(404);
    await expect(
      page.getByText('This link has been used or has expired — ask for a new one.'),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in\/email$/);
    await expectNoAxe();
    await page.getByRole('button', { name: 'Back to sign in' }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    await page.goto('/sign-in/email');
    await expect(page.getByText(/This link is not complete/)).toBeVisible();
  });

  test('says why they are here when the session ended or the round trip failed', async ({
    page,
  }) => {
    await page.goto('/sign-in?reason=ended');
    await expect(page.getByText('Your session ended')).toBeVisible();
    await page.goto('/sign-in?error=1');
    await expect(page.getByText('Sign-in did not finish')).toBeVisible();
  });

  /**
   * The round trip as the browser makes it (D-121): GitHub sends the browser to the API's
   * callback, and a sign-in that did not finish lands back here with a sentence — never on
   * the API's JSON. Neither case needs GitHub: a cancel carries no code, and a callback
   * without this browser's state cookie is refused before GitHub is asked.
   */
  test('a callback that did not finish lands back here, saying why and what to do', async ({
    page,
  }) => {
    await page.goto('/auth/github/callback?error=access_denied&state=anything');
    await expect(page).toHaveURL(/\/sign-in\?error=cancelled$/);
    await expect(page.getByRole('main').getByRole('status')).toHaveText(
      'You cancelled on GitHub — continue with GitHub whenever you are ready.',
    );
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();

    await page.goto('/auth/github/callback?code=a-code&state=not-this-browsers');
    await expect(page).toHaveURL(/\/sign-in\?error=expired$/);
    await expect(page.getByRole('main').getByRole('status')).toHaveText(
      'That sign-in expired or was started in another browser — start again from here.',
    );
  });

  test('"Continue with GitHub" leaves for the API, which sends the browser to GitHub with a state', async ({
    page,
  }) => {
    await page.goto('/sign-in');
    const link = page.getByRole('link', { name: 'Continue with GitHub' });
    await expect(link).toHaveAttribute('href', '/auth/github');
    const response = await page.request.get('/auth/github', { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    const location = new URL(response.headers()['location'] ?? '');
    expect(location.origin).toBe('https://github.com');
    expect(location.searchParams.get('scope')).toBe('read:user user:email');
    expect(location.searchParams.get('state')).not.toBeNull();
    // The state is bound to this browser by a host-only, HttpOnly cookie (D-38, D-62).
    expect(response.headers()['set-cookie'] ?? '').toContain('__Host-purlay_oauth_state=');
  });
});

test.describe('signed in', () => {
  test('lands in a channel the person belongs to, and the sign-in screen does not keep them', async ({
    page,
    signIn,
    world,
  }) => {
    await signIn();
    await page.goto('/');
    await expect(page).toHaveURL(new RegExp(`/w/${world.workspace.slug}/c/[0-9a-f-]{36}$`));
    await page.goto('/sign-in');
    await expect(page).toHaveURL(new RegExp(`/w/${world.workspace.slug}/c/`));
  });

  test('a workspace they are not in is not found, like one that does not exist', async ({
    page,
    signIn,
  }) => {
    await signIn();
    await page.goto('/w/somebody-elses');
    await expect(page.getByRole('heading', { level: 1, name: 'Nothing here' })).toBeVisible();
  });
});
