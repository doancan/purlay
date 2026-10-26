/**
 * Authorising the native application, through the page and against the real server (D-191).
 *
 * The application opens `/sign-in/native?challenge=…&state=…` in the browser; a signed-in person is asked, says
 * yes, and the server answers the one address the application is sent to. The test then plays the application:
 * it spends the code with the verifier it kept, as the application does, and gets a session of its own.
 */
import { createHash, randomBytes } from 'node:crypto';
import { NATIVE_REDIRECT } from '@purlay/types';
import { expect, test } from './fixtures';

const verifier = (): string => randomBytes(32).toString('base64url');
const challengeOf = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');
const state = (): string => randomBytes(16).toString('base64url');

test.describe('the page that authorises the native application', () => {
  test('asks the signed-in person, names the account, and makes a code only the application can spend', async ({
    page,
    signIn,
    expectNoAxe,
  }) => {
    await signIn();
    const secret = verifier();
    const asked = state();
    await page.goto(`/sign-in/native?challenge=${challengeOf(secret)}&state=${asked}`);

    // The question is the page's, and the address it was opened with is gone from the bar and the history.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Open Purlay for Mac?' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in\/native$/);
    await expect(page.getByText(/will be signed in as/)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Sign out of this browser and use another account' }),
    ).toBeVisible();
    await expectNoAxe();

    const authorised = page.waitForResponse('**/api/native/authorize');
    await page.getByRole('button', { name: 'Open Purlay for Mac' }).click();
    const response = await authorised;
    expect(response.status()).toBe(200);
    const { redirect } = (await response.json()) as { redirect: string };
    const url = new URL(redirect);
    expect(`${url.protocol}//${url.host}`).toBe(NATIVE_REDIRECT);
    expect(url.searchParams.get('state')).toBe(asked);
    const code = url.searchParams.get('code') ?? '';
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    // Answered; asking again would make a second code for a question already answered.
    await expect(
      page.getByRole('heading', { level: 1, name: 'Back to Purlay for Mac' }),
    ).toBeVisible();

    // The application, which has no session, spends the code. A wrong verifier gets the one refusal …
    const device = { name: 'Test Mac' };
    const refused = await page.request.post('/api/native/token', {
      data: { code, verifier: verifier(), device },
    });
    expect(refused.status()).toBe(404);
    expect(await refused.json()).toMatchObject({ error: { code: 'NATIVE_CODE_NOT_FOUND' } });
    // … and the right one, a session of its own as the usual cookie.
    const spent = await page.request.post('/api/native/token', {
      data: { code, verifier: secret, device },
    });
    expect(spent.status()).toBe(204);
    expect(spent.headers()['set-cookie']).toContain('purlay_session=');
    // Once: the same code again gets the same refusal.
    const again = await page.request.post('/api/native/token', {
      data: { code, verifier: secret, device },
    });
    expect(again.status()).toBe(404);
  });

  test('says the sign-in has expired, with a way back, when it was opened without a question', async ({
    page,
    signIn,
    expectNoAxe,
  }) => {
    await signIn();
    await page.goto('/sign-in/native');
    await expect(
      page.getByRole('heading', { level: 1, name: 'This sign-in has expired' }),
    ).toBeVisible();
    await expect(page.getByText('Start again from Purlay for Mac.')).toBeVisible();
    await expectNoAxe();
    await page.getByRole('button', { name: 'Go to Purlay' }).click();
    await expect(page).not.toHaveURL(/\/sign-in\/native/);
  });

  test('keeps a question that is not the shape from being asked at all', async ({
    page,
    signIn,
  }) => {
    await signIn();
    await page.goto(`/sign-in/native?challenge=${'a'.repeat(42)}&state=${state()}`);
    await expect(
      page.getByRole('heading', { level: 1, name: 'This sign-in has expired' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Purlay for Mac' })).toHaveCount(0);
  });

  test('is a sign-in first for somebody signed out, and the question is still there after', async ({
    page,
  }) => {
    await page.goto(`/sign-in/native?challenge=${challengeOf(verifier())}&state=${state()}`);
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Purlay' })).toBeVisible();
    const held = await page.evaluate(() => window.sessionStorage.getItem('purlay.native'));
    expect(JSON.parse(held ?? 'null') as unknown).toMatchObject({ state: expect.any(String) });
  });
});
