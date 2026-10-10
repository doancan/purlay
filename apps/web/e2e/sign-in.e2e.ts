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

  test('says why they are here when the session ended or the round trip failed', async ({
    page,
  }) => {
    await page.goto('/sign-in?reason=ended');
    await expect(page.getByText('Your session ended')).toBeVisible();
    await page.goto('/sign-in?error=1');
    await expect(page.getByText('Sign-in did not finish')).toBeVisible();
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
