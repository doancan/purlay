/**
 * Single sign-on through the screens, against a real server and a provider that is as strict as a real one
 * (D-200, `UX.md` §11): the administrator connects it in Administration → Server — a wrong secret refused in the
 * provider's words and nothing kept, the right one kept — and then a person who has never been here signs in by
 * the button, is sent to the provider and back, and is signed in; the native application's pending sign-in
 * survives the round trip; and a provider that does not vouch for an address signs nobody in, in the screen's words.
 *
 * Its own server, scratch database, GitHub stand-in and provider (`fresh.ts`); run narrow and light, since the
 * other specs of the wizard hold the wide and the dark.
 */
import { createHash, randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { portFor, startFresh, type FreshServer } from './fresh';

const PORT = portFor(80);

let fresh: FreshServer | null = null;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({}, info) => {
  test.skip(info.project.name !== 'chromium-light-narrow', 'one run proves the path');
  test.setTimeout(240_000);
  fresh = await startFresh(PORT);
});

test.afterAll(() => {
  fresh?.stop();
});

test('the administrator connects the provider, and a newcomer signs in through it', async ({
  browser,
}) => {
  if (fresh === null) throw new Error('the server did not start');
  const { origin, code, github, oidc } = fresh.manifest;
  const context = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });

  // The setup, finished through the API; sign-up is open so the newcomer below may make an account.
  const send = async (path: string, data?: unknown): Promise<void> => {
    const response = await context.request.post(path, { data, headers: { origin } });
    expect(response.ok(), `${path}: ${String(response.status())} ${await response.text()}`).toBe(
      true,
    );
  };
  await send('/setup/claim', { code });
  await send('/setup/admin', {
    name: 'Ayse Demir',
    email: 'ayse@example.test',
    password: 'a long and unusual phrase 7',
  });
  await send('/setup/address', { confirmed: true });
  await send('/setup/policy', { signUp: 'open' });
  await send('/setup/github', {
    clientId: github.clientId,
    clientSecret: github.clientSecret,
    save: true,
  });
  await send('/setup/smtp', { skip: true });
  await send('/setup/workspace', { name: 'Acme Engineering', slug: 'acme-engineering' });
  await send('/setup/invite');
  await send('/setup/finish');

  const page = await context.newPage();
  await page.goto('/w/acme-engineering/settings/server');
  const card = page.getByRole('region', { name: 'Single sign-on' });
  await expect(card.getByText('Not connected')).toBeVisible();
  await expect(card.getByText(`${origin}/auth/callback/oidc`)).toBeVisible();

  // A wrong secret: the provider's words, nothing kept, and what was typed is still there.
  await card.getByRole('button', { name: 'Connect single sign-on' }).click();
  await card.getByLabel('Issuer').fill(oidc.issuer);
  await card.getByLabel('Client ID').fill(oidc.clientId);
  await card.getByLabel('Client secret').fill('wrong-secret');
  await card.getByLabel('Button label').fill('Acme SSO');
  await card.getByRole('button', { name: 'Try the connection and save' }).click();
  await expect(
    card.getByText('The provider knows this client and refused its secret.'),
  ).toBeVisible();
  await expect(card.getByLabel('Issuer')).toHaveValue(oidc.issuer);
  expect(await (await page.request.get('/api/auth/methods')).json()).toMatchObject({ oidc: null });

  // The right one is kept, and the sign-in screens are told at once.
  await card.getByLabel('Client secret').fill(oidc.clientSecret);
  await card.getByRole('button', { name: 'Try the connection and save' }).click();
  await expect(
    card.getByText('Saved. Single sign-on uses this provider from now on.'),
  ).toBeVisible();
  await expect(card.getByText(`Issuer ${oidc.issuer}`)).toBeVisible();
  // Never shown again, and nowhere on the page.
  expect(await page.content()).not.toContain(oidc.clientSecret);
  expect(await (await page.request.get('/api/auth/methods')).json()).toMatchObject({
    oidc: { name: 'Acme SSO' },
  });

  // A newcomer, signed out: the button, the provider, and back signed in.
  const newcomer = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const screen = await newcomer.newPage();
  await screen.goto('/sign-in');
  const button = screen.getByRole('link', { name: 'Continue with Acme SSO' });
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('href', '/auth/oidc');
  // The provider is a page of somebody else's: the browser leaves, and comes back by itself.
  await Promise.all([
    screen.waitForURL((url) => url.origin === origin && url.pathname !== '/sign-in'),
    button.click(),
  ]);
  const me = await screen.request.get('/api/me');
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ email: 'ada.sso@example.test' });
  // The session cookie is the library's, as every way in's.
  const cookies = await newcomer.cookies();
  const session = cookies.find((cookie) => cookie.name === '__Host-purlay_session');
  expect(session).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  await newcomer.close();

  // The application's pending sign-in survives the round trip through the provider (D-191).
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const app = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const native = await app.newPage();
  await native.goto(
    `/sign-in/native?challenge=${challenge}&state=${randomBytes(16).toString('base64url')}`,
  );
  await expect(native).toHaveURL(/\/sign-in$/);
  await expect(native.getByText('Sign in to continue to Purlay for Mac.')).toBeVisible();
  await native.getByRole('link', { name: 'Continue with Acme SSO' }).click();
  await expect(
    native.getByRole('heading', { level: 1, name: 'Open Purlay for Mac?' }),
  ).toBeVisible();
  await app.close();

  // A provider that does not vouch for the address signs nobody in, and the screen says so in words.
  const control = await context.request.post(`${oidc.issuer}/__control`, {
    data: { behaviour: { claims: { email_verified: false } } },
  });
  expect(control.status()).toBe(204);
  const refused = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce' });
  const again = await refused.newPage();
  await again.goto('/sign-in');
  await again.getByRole('link', { name: 'Continue with Acme SSO' }).click();
  await expect(again).toHaveURL(/\/sign-in\?error=email-unverified$/);
  await expect(
    again.getByText('Single sign-on did not say your email address is verified', { exact: false }),
  ).toBeVisible();
  expect((await again.request.get('/api/me')).status()).toBe(401);
  await refused.close();
  await context.close();
});
