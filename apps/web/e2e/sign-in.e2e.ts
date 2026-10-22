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

  test('offers no link by email where the server sends no mail, as the demo does not', async ({
    page,
  }) => {
    const methods = page.waitForResponse('**/api/auth/methods');
    await page.goto('/sign-in');
    expect(await (await methods).json()).toEqual({
      github: true,
      email: false,
      signUp: 'invite-only',
    });
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
    // The password is always offered; the link by email is not, with no mail.
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /sign-in link/ })).toHaveCount(0);
  });

  /**
   * A server with no way in connected waits for its setup (D-179 §4). The e2e server has GitHub, so
   * the screen is told, as a server in setup mode tells it, that nothing is connected; the real
   * server's answer in that state is the process test's (`migrate-on-start.integration.test.ts`).
   */
  test('says plainly that the server is not set up when no way in is connected', async ({
    page,
    expectNoAxe,
  }) => {
    await page.route('**/api/auth/methods', async (route) => {
      await route.fulfill({ json: { github: false, email: false, signUp: 'invite-only' } });
    });
    await page.goto('/sign-in');
    await expect(
      page.getByRole('heading', { level: 2, name: 'This server is not set up yet' }),
    ).toBeVisible();
    await expect(page.getByText(/If you run this server/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toHaveCount(0);
    // The password form stays (R30); nothing else is offered.
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /sign-in link/ })).toHaveCount(0);
    await expectNoAxe();
  });

  /**
   * The methods answer fails once: the query asks again by itself, and the person sees only the button.
   * Failing for good, the screen keeps the button (the historical default) and says the check failed,
   * with a way to ask again (R45).
   */
  test('a hiccup in asking what the server offers is retried; failing for good keeps the button and says so', async ({
    page,
  }) => {
    let asked = 0;
    await page.route('**/api/auth/methods', async (route) => {
      asked += 1;
      if (asked === 1) await route.abort('failed');
      else await route.continue();
    });
    await page.goto('/sign-in');
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
    await expect(page.getByText(/could not check which sign‑in options/)).toHaveCount(0);
    expect(asked).toBe(2);

    await page.unroute('**/api/auth/methods');
    await page.route('**/api/auth/methods', async (route) => {
      await route.abort('failed');
    });
    await page.goto('/sign-in');
    await expect(
      page.getByText('We could not check which sign‑in options this server offers.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: /sign-in link/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
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

  test('says what to do when the address is an unverified account’s (on the demo, which sends no mail), or the server takes no strangers', async ({
    page,
    expectNoAxe,
  }) => {
    await page.goto('/sign-in?error=email-taken');
    await expect(page.getByRole('main').locator('p[role="status"]')).toHaveText(
      'An account with that email exists, but its address is not verified yet, so GitHub cannot sign in to it. It is a password account made when this server was set up: sign in with its password. This server sends no email, so the address stays unverified and GitHub will not sign in to it.',
    );
    await expectNoAxe();
    await page.goto('/sign-in?error=signup-closed');
    await expect(page.getByRole('main').locator('p[role="status"]')).toHaveText(
      'This Purlay server makes accounts by invitation only — ask someone on it for an invitation link.',
    );
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
    await page.goto('/auth/callback/github?error=access_denied&state=anything');
    await expect(page).toHaveURL(/\/sign-in\?error=cancelled$/);
    await expect(page.getByRole('main').locator('p[role="status"]')).toHaveText(
      'You cancelled on GitHub — continue with GitHub whenever you are ready.',
    );
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toBeVisible();

    await page.goto('/auth/callback/github?code=a-code&state=not-this-browsers');
    await expect(page).toHaveURL(/\/sign-in\?error=expired$/);
    await expect(page.getByRole('main').locator('p[role="status"]')).toHaveText(
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
